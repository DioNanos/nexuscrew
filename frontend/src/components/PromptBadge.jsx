import { t } from '../lib/i18n.js';
import './PromptBadge.css';

// Il badge della consegna del prompt: una riga locale della cella, accanto allo
// stato e mai al posto suo. Il testo viene da una chiave di traduzione e il
// colore da un enum chiuso — nessun testo che arrivi dal nodo.
export default function PromptBadge({ prompt }) {
  if (!prompt || !prompt.key) return null;
  const testo = t(prompt.key);
  return (
    <span className={`nc-prompt-badge nc-prompt-badge-${prompt.badge}`} title={testo} aria-label={testo}>
      {testo}
    </span>
  );
}
