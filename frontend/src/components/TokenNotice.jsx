import { useEffect, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { TOKEN_NOT_REMEMBERED_EVENT } from '../lib/token-store.js';
import './UpdatePrompt.css';

// Avviso non bloccante: il browser ha rifiutato di scrivere il token (quota, modalita' privata). L'app
// funziona nella sessione, ma alla prossima apertura servira' reinserirlo: meglio dirlo che perderlo in silenzio.
export default function TokenNotice() {
  useLang();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const on = () => setShown(true);
    window.addEventListener(TOKEN_NOT_REMEMBERED_EVENT, on);
    return () => window.removeEventListener(TOKEN_NOT_REMEMBERED_EVENT, on);
  }, []);
  if (!shown) return null;
  return (
    <div className="nc-update" role="status" aria-live="polite">
      <span className="nc-update-msg">{t('auth-not-remembered')}</span>
      <button className="nc-update-close" onClick={() => setShown(false)} aria-label={t('update-dismiss')} title={t('update-dismiss')}>×</button>
    </div>
  );
}
