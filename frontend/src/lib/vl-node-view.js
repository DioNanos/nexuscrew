// Salute e collegamento di un nodo VL, derivati da ciò che il device dichiara.
//
// IL PUNTO: il broker emette `state` (`running|starting|stopped|degraded|error`,
// `lib/vl-nodes/broker.js` sanitizeHealth), mentre `healthDot` riconosce
// `status: 'healthy'`. Rinominare il campo non basta, e non basta nemmeno
// mappare `running` → `healthy`: `running` è un'auto-dichiarazione del device,
// non la prova che l'host risponda.
//
// Tabella esplicita, la stessa scritta nel referto dello strato:
//
//   state       prova                                esito    motivo
//   status      healthy/passive (affermato)         tale e quale  il produttore lo dichiara
//   running     brokerReachable === true             healthy  broker attestato
//   running     qualsiasi altro                      warn     auto-dichiarato, senza prova del broker
//   starting    —                                    warn     avvio in corso
//   degraded    —                                    warn     degradato
//   error       —                                    warn     errore
//   stopped     —                                    warn     fermo
//   assente     —                                    null     salute non dichiarata (nessun secondo indicatore)
//   fuori tab.  —                                    null     vocabolario non nostro: nessuna diagnosi
//
// Freschezza: `current` solo con `online === true` e un `lastSeen` entro la
// finestra (mai nel futuro); altrimenti `stale`. E la freschezza DECIDE: un
// dato non corrente non produce mai `healthy`, nemmeno con il broker attestato.

import { t } from './i18n.js';

const PROVA_BROKER = 'brokerReachable';
const FINESTRA_FRESCHEZZA_MS = 90_000;

const MOTIVI = Object.freeze({
  running: 'vl-health-running-unproven',
  starting: 'vl-health-starting',
  degraded: 'vl-health-degraded',
  error: 'vl-health-error',
  stopped: 'vl-health-stopped',
});

// healthView(health, { online, lastSeen, now }) -> { status, detail, freshness }
// status: 'healthy' | 'warn'  (le due forme che healthDot conosce)
export function healthView(health, { online = false, lastSeen = null, now = Date.now() } = {}) {
  const h = health && typeof health === 'object' && !Array.isArray(health) ? health : null;
  // La freschezza NON e' decorazione: senza un lastSeen utilizzabile, o con un
  // dato vecchio (o nel futuro), il risultato non e' corrente — e piu' sotto
  // questo basta a togliere il verde, anche quando il broker e' attestato.
  const eta = Number.isFinite(lastSeen) ? now - lastSeen : null;
  const fresco = online === true && eta !== null && eta >= 0 && eta <= FINESTRA_FRESCHEZZA_MS;
  const freshness = fresco ? 'current' : 'stale';
  // Idempotenza: un `health` che porta gia' un `status` e' un esito derivato
  // (dal modello o da un produttore che lo dichiara) e si rispetta com'e'.
  // Senza questo, applicare la derivazione due volte — modello e componente —
  // cancellerebbe il primo risultato.
  if (h && Object.prototype.hasOwnProperty.call(h, 'status')) {
    const dichiarato = h.status === 'healthy' || h.status === 'passive' || h.status === 'warn' ? h.status : null;
    // Vale anche per un esito gia' derivato: se il dato non e' corrente, il
    // verde non si mostra. Il resto (passive/warn/null) resta com'e'.
    const status = dichiarato === 'healthy' && freshness !== 'current' ? 'warn' : dichiarato;
    return { status, detail: typeof h.detail === 'string' ? h.detail : null, freshness };
  }
  const stato = h && typeof h.state === 'string' ? h.state : null;

  // Salute NON dichiarata: NON si produce un oggetto. Un `{status: null}` è
  // truthy, e un consumatore che guarda la sola presenza lo trasforma in un
  // avviso: l'assenza va rappresentata come assenza. Il gruppo mostra già il
  // suo stato, e un pallino su un'informazione che il device non ha mandato
  // sarebbe un'affermazione nostra.
  if (!h) return null;
  if (stato === null) {
    const suo = typeof h.detail === 'string' && h.detail.trim() ? h.detail : null;
    return { status: null, detail: suo, freshness };
  }
  // Un produttore che dichiara `status: healthy` fa un'affermazione esplicita
  // sulla salute: si rispetta. Il broker di oggi non lo emette — manda `state`
  // — ed è per questo che il ramo sotto esiste.
  if (h.status === 'healthy' || h.status === 'passive') {
    return { status: h.status, detail: h.detail || t('vl-health-running-proven'), freshness };
  }
  if (stato === 'running') {
    const attestato = h[PROVA_BROKER] === true;
    const nostro = t(attestato ? 'vl-health-running-proven' : MOTIVI.running);
    // Un'osservazione vecchia non prova lo stato di adesso: il verde si nega.
    if (attestato && freshness !== 'current') {
      return {
        status: 'warn',
        detail: typeof h.detail === 'string' && h.detail.trim() ? h.detail : t('vl-health-running-stale'),
        freshness,
      };
    }
    return {
      status: attestato ? 'healthy' : 'warn',
      // Il dettaglio del device e' informazione: si tiene, e il nostro testo
      // resta il ripiego quando il device non ne manda uno.
      detail: typeof h.detail === 'string' && h.detail.trim() ? h.detail : nostro,
      freshness,
    };
  }
  // Uno stato che non conosciamo (il device dichiara qualcosa che non è nella
  // tabella) non è un'affermazione che possiamo fare: nessun secondo
  // indicatore, come per la salute assente. Non lo si traduce in «guasto» per
  // prudenza — sarebbe una diagnosi su un vocabolario altrui.
  const motivo = MOTIVI[stato];
  // Vocabolario non nostro: nessun indicatore, ma il dettaglio che il device
  // ha mandato resta informazione e non si butta.
  if (!motivo) {
    const suo = typeof h.detail === 'string' && h.detail.trim() ? h.detail : null;
    return { status: null, detail: suo, freshness };
  }
  const dettaglio = typeof h.detail === 'string' && h.detail.trim() ? h.detail : t(motivo);
  return { status: 'warn', detail: dettaglio, freshness };
}

// connectionState(node) -> 'online' | 'never-connected' | 'offline'
// «Mai collegato» non è «offline»: il primo non ha mai avuto un heartbeat, il
// secondo l'ha avuto e l'ha perso. Distinguerli è la differenza fra «guarda il
// device» e «aspetta che torni».
export function connectionState(node) {
  const n = node && typeof node === 'object' ? node : {};
  if (n.online === true) return 'online';
  return n.lastSeen === null || n.lastSeen === undefined ? 'never-connected' : 'offline';
}
