import { t } from '../lib/i18n.js';
import './PromptBadge.css';

// Il badge della consegna del prompt: una riga locale della cella, accanto allo
// stato e mai al posto suo. Il testo viene da una chiave di traduzione e il
// colore da un enum chiuso — nessun testo che arrivi dal nodo.
//
// In card resta SOLO ciò che chiede una risposta ADESSO all'operatore (prompt
// rifiunato, permesso/consenso/onboarding): «serve una risposta». Gli altri
// esiti — consegna fallita, esito non attestato, in consegna, consegnato —
// sono dettaglio del FOGLIO della cella (sezione Prompt iniziale), non
// allarmi da riga (P3-2).
export default function PromptBadge({ prompt }) {
  if (!prompt || prompt.badge !== 'action' || !prompt.key) return null;
  // Da una lettura non corrente il dato e' l'ultimo noto, e va detto: il badge
  // non lo presenta mai come un'attestazione di adesso.
  const testo = prompt.freschezza === 'last-known'
    ? `${t(prompt.key)} · ${t('prompt-badge-last-known')}`
    : t(prompt.key);
  return (
    <span className={`nc-prompt-badge nc-prompt-badge-${prompt.badge}`} title={testo} aria-label={testo}>
      {testo}
    </span>
  );
}
