// Estrae la notifica "azione richiesta nel terminale della cella" dal risultato
// di /api/fleet/up (0.8.47). Il backend la emette quando il bootstrap prompt
// non puo' essere consegnato perche' il TUI e' in consenso/auth/onboarding:
// la sessione resta viva e l'operatore agisce nel terminale, poi riavvia.
//
// Federazione (R6): il risultato puo' arrivare da un nodo REMOTO. Il testo
// recoveryText del server NON viene mai mostrato: code e recovery sono closed
// enum/slug validati localmente e il testo viene dalla mappa i18n locale.
// Qualunque payload fuori enum -> null (niente rendering di testo remoto).

import { t } from './i18n.js';
import { fleetDown, fleetUp } from './api.js';

const ACTION_CODES = ['KIMI_AUTH_ACTION_REQUIRED', 'CLIENT_INTERACTION_REQUIRED'];
const RECOVERY_SLUGS = [
  'kimi-code-consent-yes',
  'kimi-code-config-custom-api-key',
  'kimi-cli-login',
  'client-terminal-dialog',
];

export function upActionNotice(result) {
  const ar = result && typeof result === 'object' ? result.actionRequired : null;
  if (ar && typeof ar === 'object') {
    if (ACTION_CODES.includes(ar.code) && RECOVERY_SLUGS.includes(ar.recovery)) {
      return { code: ar.code, recovery: ar.recovery, text: t(`fleet-recovery-${ar.recovery}`) };
    }
  }
  // V-69: /fleet/up porta vlPromptDegraded:true quando una cella vl parte
  // senza il proprio prompt di cella (il runtime sul nodo non regge
  // VL_SYSTEM_APPEND_FILE, 0.3.1+, o il file per-cella non e' scrivibile in
  // sicurezza). La cella e' viva ma lavora senza la sua identita'. Booleano
  // strict === true e testo i18n locale, come per i flag qui accanto.
  // Ordine: actionRequired > vlPromptDegraded > readinessDegraded — l'identita'
  // mancante pesa piu' del timing di prontezza (chi non elabora subito verra'
  // comunque riscoperto al primo incarico; chi lavora senza prompt sbaglia).
  if (result && typeof result === 'object' && result.vlPromptDegraded === true) {
    return { code: 'VL_PROMPT_DEGRADED', recovery: null, text: t('fleet-vl-prompt-degraded') };
  }
  // R27 #3: /fleet/up porta readinessDegraded:true quando una cella vl parte
  // senza marcatore di prontezza (DEC1 in runtime.js: degrada e procede).
  // Quel risultato veniva scartato e la cella appariva semplicemente «attiva»:
  // l'incarico finiva in un terminale che non elabora. Booleano strict === true
  // perche' il payload puo' arrivare da un nodo remoto federato; il testo, come
  // per actionRequired, e' sempre i18n locale. actionRequired vince: chiede
  // un'azione precisa nel terminale ed e' piu' specifico del degrado.
  if (result && typeof result === 'object' && result.readinessDegraded === true) {
    // Degrado MCP (celle claude gestite): la notice porta l'elenco bounded dei
    // server non pronti accanto al testo i18n locale del degrado.
    if (result.mcpDegraded && typeof result.mcpDegraded === 'object') {
      const elenco = [
        ...(Array.isArray(result.mcpDegraded.failed) ? result.mcpDegraded.failed : []),
        ...(Array.isArray(result.mcpDegraded.pending) ? result.mcpDegraded.pending : []),
      ].filter((s) => typeof s === 'string' && s).slice(0, 16);
      if (elenco.length) {
        return { code: 'READINESS_DEGRADED', recovery: null, text: t('fleet-mcp-degraded') + ' ' + elenco.join(', ') };
      }
    }
    return { code: 'READINESS_DEGRADED', recovery: null, text: t('fleet-readiness-degraded') };
  }
  return null;
}

// Esiti di alimentazione che il foglio NON deve trattare come errori. Tre
// famiglie:
// - timeout client (FLEET_ACTION_TIMEOUT_MS in api.js): l'azione può
//   completare sul server dopo la chiusura del foglio — l'esito reale arriva
//   dal roster;
// - 502 «upstream-timeout» del proxy federato (PROXY_TIMEOUT_MS): la cella
//   remota può essere ancora in avvio mentre il proxy ha già risposto;
// - 409 SESSION_DUPLICATE su 'up' (preflight del runtime: la sessione esiste
//   già). La cella è viva, non serve rilanciare.
// 'down' non ha il 409: è idempotente per progetto (la kill di una sessione
// assente non è errore) e risolve sempre con ok.
export function fleetActionErrorNotice(error, action) {
  if (!error) return null;
  // Due facce della stessa attesa: il timeout client (FLEET_ACTION_TIMEOUT_MS)
  // e il 502 «upstream-timeout» del proxy federato (PROXY_TIMEOUT_MS, 30 s),
  // che su una cella remota arriva PRIMA del tetto client mentre il nodo
  // remoto può essere ancora al lavoro. Entrambe: il foglio si chiude, la
  // notice avvisa, l'esito reale arriva dal roster.
  const slowRoute = error.status === 502
    && error.data && error.data.cause === 'upstream-timeout';
  if (error.name === 'TimeoutError' || slowRoute) {
    return {
      code: 'FLEET_ACTION_TIMEOUT',
      recovery: null,
      text: t(action === 'down' ? 'fleet-down-slow' : 'fleet-up-slow'),
    };
  }
  if (error.status === 409
    && action === 'up'
    && error.data && error.data.code === 'SESSION_DUPLICATE') {
    return { code: 'FLEET_SESSION_DUPLICATE', recovery: null, text: t('fleet-up-duplicate') };
  }
  return null;
}

// Percorso comune del confermo del foglio di alimentazione, mobile e desktop:
// lancia l'azione, mostra le notice di esito e mappa gli esiti benigni.
// Ritorna { benign } quando l'esito è benigno (il chiamante non tocca il flag
// di boot: l'esito reale non è noto, o non è cambiato nulla) e undefined per
// l'esito pieno. Gli errori veri vengono rilanciati: restano nel foglio, che
// li mostra con i pulsanti riabilitati.
export async function runFleetPowerAction({ token, powerCell, payload, onNotice, fleetApi }) {
  const api = fleetApi || { fleetUp, fleetDown };
  const { cell } = powerCell;
  const route = Array.isArray(powerCell.route) ? powerCell.route : [];
  try {
    if (payload.action === 'up') {
      const res = await api.fleetUp(token, {
        cell, boot: !!payload.boot,
        ...(payload.engine ? { engine: payload.engine } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.permissionPolicy ? { permissionPolicy: payload.permissionPolicy } : {}),
      }, route);
      const notice = upActionNotice(res);
      if (notice) onNotice(notice.text);
    } else {
      await api.fleetDown(token, { cell, boot: !!payload.boot }, route);
    }
    return undefined;
  } catch (e) {
    const benign = fleetActionErrorNotice(e, payload.action);
    if (benign) { onNotice(benign.text); return { benign: benign.code }; }
    throw e;
  }
}
