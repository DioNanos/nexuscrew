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
  if (!ar || typeof ar !== 'object') return null;
  if (!ACTION_CODES.includes(ar.code)) return null;
  if (!RECOVERY_SLUGS.includes(ar.recovery)) return null;
  return { code: ar.code, recovery: ar.recovery, text: t(`fleet-recovery-${ar.recovery}`) };
}
