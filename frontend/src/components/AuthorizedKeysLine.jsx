import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { copyText } from '../lib/clipboard.js';
import './AuthorizedKeysLine.css';

// La riga `authorized_keys` che il peer deve sostituire dopo un pairing con
// pannello. UN SOLO componente, usato sia dalla card sia dal Wizard: il
// percorso del primo pairing smonta la card al successo, quindi la riga deve
// poter comparire anche altrove — e due copie dello stesso blocco
// divergerebbero alla prima modifica.
//
// La riga contiene una chiave PUBBLICA e due destinazioni di forward: nulla di
// segreto, ed è esattamente il testo che l'utente deve incollare sul peer.
// Senza di essa il forward del pannello resta rifiutato dal server, e il
// tunnel sembra vivo mentre il pannello non risponde.
export default function AuthorizedKeysLine({ line, note }) {
  const [copied, setCopied] = useState(false);
  if (!line) return null;
  return (
    <div className="nc-authkeys" role="group">
      <div className="nc-sheet-label">{t('pair-authkeys-title')}</div>
      <small className="nc-set-hint">{note || t('pair-authkeys-hint')}</small>
      <textarea className="nc-authkeys-line" readOnly rows={3} value={line}
        aria-label={t('pair-authkeys-title')}
        onFocus={(e) => e.target.select()} />
      <button type="button" className="nc-btn ghost"
        onClick={async () => { setCopied(await copyText(line)); }}>
        {copied ? t('pair-authkeys-copied') : t('pair-authkeys-copy')}
      </button>
    </div>
  );
}
