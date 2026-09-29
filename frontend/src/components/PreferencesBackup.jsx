import { useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { resolveSharedConflict, usePrefsSyncState } from '../hooks/usePrefsSync.js';
import { collectPrefs, exportPrefs, importPrefs, isEmptyPrefs } from '../lib/prefs-sync.js';

// Backup delle preferenze: stato della copia sul nodo, scelta in caso di conflitto, export/import a file.
// Il file contiene solo pin, ordini e viste: mai il token.
const readText = (file) => (typeof file.text === 'function' ? file.text() : new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error); reader.readAsText(file);
}));

export default function PreferencesBackup({ token = '' }) {
  useLang();
  const state = usePrefsSyncState();
  const input = useRef(null);
  const resolve = (choice) => resolveSharedConflict(token, choice);
  const [message, setMessage] = useState(null);

  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportPrefs()], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'nexuscrew-preferences.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage({ ok: true, text: t('prefs-export-done') });
    } catch (error) { setMessage({ ok: false, text: String(error?.message || error) }); }
  };

  const pick = async (event) => {
    const chosen = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!chosen) return;
    let text = '';
    try { text = await readText(chosen); } catch (error) { setMessage({ ok: false, text: String(error?.message || error) }); return; }
    if (!isEmptyPrefs(collectPrefs()) && !window.confirm(t('prefs-import-confirm'))) return;
    const result = importPrefs(text);
    setMessage(result.ok ? { ok: true, text: t('prefs-import-done') } : { ok: false, text: t(result.reason === 'not-json' || result.reason === 'wrong-kind' ? 'prefs-import-wrong' : result.reason === 'storage-write-failed' ? 'prefs-import-storage' : 'prefs-import-bad') });
  };

  return (
    <div className="nc-set-form nc-prefs-backup">
      <div className="nc-sheet-label">{t('prefs-backup')}</div>
      <div data-testid="sync-status" className="nc-set-hint">{t('prefs-sync')}: {state.status}{state.revision !== undefined ? ` (r${state.revision})` : ''}{state.code ? ` · ${state.code}` : ''}{state.note ? ` · ${state.note}` : ''}</div>
      {state.status === 'conflict' && (
        <div className="nc-set-confirm" role="group" aria-label={t('prefs-conflict')}>
          <div>{t('prefs-conflict')}</div>
          <div className="nc-sheet-actions">
            <button type="button" className="nc-btn ghost" onClick={() => resolve('local')}>{t('prefs-keep-local')}</button>
            <button type="button" className="nc-btn ghost" onClick={() => resolve('server')}>{t('prefs-use-server')}</button>
          </div>
        </div>
      )}
      <div className="nc-sheet-actions">
        <button type="button" className="nc-btn ghost" onClick={download}>{t('prefs-export')}</button>
        <button type="button" className="nc-btn ghost" onClick={() => input.current && input.current.click()}>{t('prefs-import')}</button>
        <input ref={input} type="file" accept="application/json,.json" aria-label={t('prefs-import')} style={{ display: 'none' }} onChange={pick} />
      </div>
      {message && <div className={message.ok ? 'nc-set-note' : 'nc-err'} role={message.ok ? 'status' : 'alert'}>{message.text}</div>}
    </div>
  );
}
