import { useEffect, useState } from 'react';
import { t, getLang } from '../lib/i18n.js';
import { copyText } from '../lib/clipboard.js';
import { fileDisplayName, fileWhen, formatFullWhen, formatFileSize } from '../lib/files-display.js';
import Icon from './Icon.jsx';
import './FileActionsSheet.css';

// Foglio azioni del file (il «⋯» della riga): stesso guscio mobile delle
// azioni cella (CellActionsSheet) — velo che chiude al tocco, foglio dal
// basso, bersagli ≥44 px — con il contenuto specifico del file: nome
// visualizzato completo, nome ORIGINALE completo in mono, data/dimensione/
// cartella, e le azioni. «Elimina…» chiede conferma DENTRO il foglio: l'azione
// distruttiva non parte mai dal primo tocco.
//
// Il foglio non fa rete:Scarica/Anteprima/Elimina risalgono al pannello con
// l'oggetto file (che porta il nome ORIGINALE: è quello che viaggia nelle
// richieste, il prefisso si toglie solo dove si legge). «Copia nome completo»
// è pura UI e vive qui, con il suo feedback.
export default function FileActionsSheet({
  file, box, session, previewable = false, notice = '', busy = false,
  onClose, onDownload, onPreview, onDelete,
}) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  // File diverso = foglio nuovo: la conferma e il feedback copia non
  // sopravvivono al file precedente.
  const fileName = file && file.name;
  useEffect(() => { setConfirming(false); setCopied(false); }, [fileName]);

  // Escape chiude come il velo e la X.
  useEffect(() => {
    const fuga = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fuga);
    return () => document.removeEventListener('keydown', fuga);
  }, [onClose]);

  async function copiaNome() {
    // il feedback resta finché il foglio è aperto: niente timer da pulire
    setCopied(await copyText(file ? file.name : ''));
  }

  const display = fileDisplayName(fileName);
  const when = fileWhen(fileName, file ? file.mtime : 0);
  const lang = getLang();

  return (
    <div
      className="nc-filesheet-velo" data-testid="file-actions-sheet"
      onClick={onClose} /* il velo chiude; il foglio sotto ferma la propagazione */
    >
      <div
        className="nc-filesheet" role="dialog" aria-modal="true"
        aria-label={t('files-sheet-title')} onClick={(e) => e.stopPropagation()}
      >
        <div className="nc-filesheet-testa">
          <span className="nc-filesheet-titolo">{t('files-sheet-title')}</span>
          <button
            type="button" className="nc-filesheet-chiudi" onClick={onClose}
            title={t('close')} aria-label={t('close')}
          ><Icon name="x" size={18} /></button>
        </div>

        <div className="nc-filesheet-file">
          <span className="nc-filesheet-nome">{display}</span>
          <div className="nc-filesheet-originale">
            <span className="nc-filesheet-label">{t('files-original-name')}</span>
            <code className="nc-filesheet-mono">{fileName}</code>
          </div>
          <small className="nc-filesheet-meta">
            {formatFullWhen(when, lang)} · {formatFileSize(file ? file.size : 0)} · {box === 'outbox' ? 'Outbox' : 'Inbox'} · {session}
          </small>
        </div>

        {notice && <div className="nc-filesheet-notice" role="status">{notice}</div>}

        {confirming ? (
          <div className="nc-filesheet-conferma" data-testid="file-delete-confirm">
            <b className="nc-filesheet-conferma-titolo">
              {t('files-delete-confirm').replace('{name}', display)}
            </b>
            <small className="nc-filesheet-conferma-aiuto">{t('files-delete-confirm-help')}</small>
            <div className="nc-filesheet-conferma-azioni">
              <button
                type="button" onClick={() => setConfirming(false)} disabled={busy}
              >{t('cancel')}</button>
              <button
                type="button" className="danger" disabled={busy}
                data-fileaction="delete-confirm" onClick={() => onDelete(file)}
              >{t('delete')}</button>
            </div>
          </div>
        ) : (
          <div className="nc-filesheet-azioni" role="menu">
            {previewable && (
              <button
                type="button" role="menuitem" disabled={busy} data-fileaction="preview"
                onClick={() => onPreview(file)}
              ><Icon name="eye" size={20} /><span>{t('files-preview')}</span></button>
            )}
            <button
              type="button" role="menuitem" disabled={busy} data-fileaction="download"
              onClick={() => onDownload(file)}
            ><Icon name="download" size={20} /><span>{t('files-download-action')}</span></button>
            <button
              type="button" role="menuitem" disabled={busy} data-fileaction="copy"
              onClick={copiaNome} aria-live="polite"
            ><Icon name="copy" size={20} /><span>{copied ? t('files-copied-name') : t('files-copy-name')}</span></button>
            <button
              type="button" role="menuitem" className="danger" disabled={busy} data-fileaction="delete"
              onClick={() => setConfirming(true)}
            ><Icon name="trash" size={20} /><span>{t('files-delete-ellipsis')}</span></button>
          </div>
        )}
      </div>
    </div>
  );
}
