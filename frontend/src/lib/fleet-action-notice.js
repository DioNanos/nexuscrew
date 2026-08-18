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
  // R27 #3: /fleet/up porta readinessDegraded:true quando una cella vl parte
  // senza marcatore di prontezza (DEC1 in runtime.js: degrada e procede).
  // Quel risultato veniva scartato e la cella appariva semplicemente «attiva»:
  // l'incarico finiva in un terminale che non elabora. Booleano strict === true
  // perche' il payload puo' arrivare da un nodo remoto federato; il testo, come
  // per actionRequired, e' sempre i18n locale. actionRequired vince: chiede
  // un'azione precisa nel terminale ed e' piu' specifico del degrado.
  if (result && typeof result === 'object' && result.readinessDegraded === true) {
    return { code: 'READINESS_DEGRADED', recovery: null, text: t('fleet-readiness-degraded') };
  }
  return null;
}
