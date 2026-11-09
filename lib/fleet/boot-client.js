'use strict';
// Fleet boot companion — client del daemon persistente della stessa
// installazione. Questo processo NON istanzia fleet, leaseManager, broker o
// record: il daemon della stessa installazione è l'unico proprietario.
//
// Discovery senza hardcode: porta da config.json (url.loadPort — dopo il
// fallback automatico del server, config.json è autorevole), token da
// ~/.nexuscrew/token (url.readToken), identità attesa = nodeId di
// ~/.nexuscrew/nodes.json (come lib/mcp/identity-provider.js). Mai la prima
// porta che risponde: /api/config deve dichiarare LO STESSO instanceId.
//
// Readiness = ben più del socket HTTP aperto: /api/config 200 con identità
// attesa, /api/fleet/status available, e supervision.lease/control 'ready'
// (stato vivo del manager — boot completato e listener in ascolto — non un
// flag di configurazione). Un daemon che non espone ancora il campo
// supervision è trattato fail-closed come assente.
//
// Esiti forti del chiamante: daemon assente/lento oltre budget, credenziale
// rifiutata, identità diversa, supervision assente oltre budget => exit 1,
// zero POST. I GET di readiness sono read-only e possono essere ritentati
// senza effetti; i POST up mai: uno per cella (boot.js).

const BOOT_BUDGET_MS = 120_000;
const PROBE_TICK_MS = 500;
const GET_TIMEOUT_MS = 5_000;
const POST_TIMEOUT_MS = 60_000;

// Motivi chiusi del fallimento readiness (enum per il caller, mai prosa).
const REASONS = Object.freeze([
  'daemon-unreachable',  // nessuna risposta utile entro il budget
  'auth-rejected',       // il nodo risponde e rifiuta il token (401/403)
  'identity-mismatch',   // risponde un NexusCrew con un altro instanceId
  'fleet-disabled',      // il daemon dichiara fleet esplicitamente disabilitata
  'fleet-unavailable',   // provider non disponibile per altra ragione
  'supervision-absent',  // lease/control assenti e mai diventati pronti
  'supervision-timeout', // supervision dichiarata ma mai 'ready' nel budget
]);

function createBootClient({ port, token, expectedInstanceId, fetchImpl = globalThis.fetch } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function request(method, urlPath, body, timeoutMs) {
    // kind 'lost' = nessun verdetto HTTP (rete, abort, corpo illeggibile):
    // il chiamante non ripete il POST alla cieca, consulta lo stato.
    try {
      const r = await fetchImpl(`${base}${urlPath}`, {
        method,
        headers: H,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout?.(timeoutMs),
      });
      let json = null;
      try { json = await r.json(); } catch (_) { json = null; }
      // Corpo illeggibile di un esito 2xx del POST: nessun verdetto interpretabile.
      // E' una risposta PERSA (si consulta lo stato, mai un secondo POST),
      // non una conferma: mai started dal solo status 2xx.
      if (json === null && method === 'POST' && r.status >= 200 && r.status < 300) {
        return { kind: 'lost' };
      }
      return { kind: 'http', status: r.status, json };
    } catch (_) {
      return { kind: 'lost' };
    }
  }

  return {
    expectedInstanceId: expectedInstanceId || null,
    config: () => request('GET', '/api/config', undefined, GET_TIMEOUT_MS),
    fleetStatus: () => request('GET', '/api/fleet/status', undefined, GET_TIMEOUT_MS),
    postUp: (cell) => request('POST', '/api/fleet/up', { cell }, POST_TIMEOUT_MS),
    launchState: (cell) => request('GET', `/api/fleet/launch-state?cell=${encodeURIComponent(cell)}`, undefined, GET_TIMEOUT_MS),
  };
}

// Attende la readiness completa dentro UN solo budget. I GET sono ritentabili
// senza effetti; auth rifiutata e identità diversa sono terminali SUBITO (non
// migliorano attendendo). Risolve con lo status JSON del daemon quando pronto.
async function awaitReady(client, {
  budgetMs = BOOT_BUDGET_MS, tickMs = PROBE_TICK_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = Date.now() + budgetMs;
  // Ultimo fatto osservato, per scegliere il motivo chiuso a scadenza.
  let ultimo = 'daemon-unreachable';
  let supervisionVista = null;

  for (;;) {
    const expected = client.expectedInstanceId;
    const cfg = await client.config();
    if (cfg.kind === 'http' && (cfg.status === 401 || cfg.status === 403)) return { ok: false, reason: 'auth-rejected' };
    if (cfg.kind === 'http' && cfg.status === 200) {
      const instanceId = cfg.json && typeof cfg.json.instanceId === 'string' ? cfg.json.instanceId : null;
      if (!expected || !instanceId || instanceId !== expected) return { ok: false, reason: 'identity-mismatch' };
      const st = await client.fleetStatus();
      if (st.kind === 'http' && st.status === 200 && st.json) {
        if (st.json.available === false) {
          if (st.json.provider === 'disabled') return { ok: false, reason: 'fleet-disabled' };
          ultimo = 'fleet-unavailable';
        } else {
          const sup = st.json.supervision;
          const lease = sup && typeof sup.lease === 'string' ? sup.lease : 'absent';
          const control = sup && typeof sup.control === 'string' ? sup.control : 'absent';
          supervisionVista = lease === 'absent' || control === 'absent' ? 'absent' : lease;
          if (lease === 'ready' && control === 'ready') return { ok: true, status: st.json };
          ultimo = supervisionVista === 'absent' ? 'supervision-absent' : 'supervision-timeout';
        }
      }
    }
    if (Date.now() >= deadline) {
      if (ultimo === 'supervision-timeout' || ultimo === 'supervision-absent') return { ok: false, reason: ultimo };
      return { ok: false, reason: ultimo };
    }
    await sleep(tickMs);
  }
}

module.exports = {
  createBootClient,
  awaitReady,
  REASONS,
  BOOT_BUDGET_MS,
  PROBE_TICK_MS,
  GET_TIMEOUT_MS,
  POST_TIMEOUT_MS,
};
