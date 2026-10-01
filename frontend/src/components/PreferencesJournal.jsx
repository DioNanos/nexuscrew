import { useEffect, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { clearOrderJournal, readOrderJournal } from '../lib/order-journal.js';
import { PERSIST_KEY, readPersistState } from '../lib/storage-persist.js';

const when = (ms) => { try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); } };
const keys = (list) => (Array.isArray(list) ? list.join(', ') : '');

// Diario delle scritture di pin/ordine/viste (ultime 50) + stato della persistenza dello storage: serve a capire
// dopo una perdita che cosa e' successo. Contiene solo nomi di celle e orari, mai token.
export default function PreferencesJournal() {
  useLang();
  const [rows, setRows] = useState(() => readOrderJournal());
  const [persist, setPersist] = useState(() => readPersistState());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const refresh = () => { setRows(readOrderJournal()); setPersist(readPersistState()); };
    window.addEventListener('storage', refresh);
    window.addEventListener('nexuscrew-roster-preferences', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('nexuscrew-roster-preferences', refresh); };
  }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(rows, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch (_) { /* appunti non disponibili: il diario resta leggibile a schermo */ }
  };
  const clear = () => { clearOrderJournal(); setRows([]); };
  const shown = [...rows].reverse();
  return (
    <div className="nc-set-form nc-prefs-journal">
      <div className="nc-sheet-label">{t('prefs-journal')}</div>
      <div data-testid="persist-status" className="nc-set-hint" data-key={PERSIST_KEY}>
        {t('prefs-persist')}: {persist ? persist.status : t('prefs-persist-unknown')}
      </div>
      {!shown.length && <div className="nc-set-hint">{t('prefs-journal-empty')}</div>}
      <div className="nc-journal-list" style={{ maxHeight: 220, overflow: 'auto' }}>
        {shown.map((row, index) => (
          <div key={`${row.t}-${index}`} data-testid="journal-row" className="nc-set-hint" style={{ overflowWrap: 'anywhere' }}>
            <b>{row.reason}</b> · {when(row.t)}{row.position ? ` · ${row.position}` : ''}{row.key ? ` · ${row.key}` : ''}{row.note ? ` · ${row.note}` : ''}
            {row.before ? <div>{t('prefs-before')}: {keys(row.before)}</div> : null}
            {row.after ? <div>{t('prefs-after')}: {keys(row.after)}</div> : null}
            {row.visible ? <div>{t('prefs-visible')}: {keys(row.visible)}</div> : null}
          </div>
        ))}
      </div>
      <div className="nc-sheet-actions">
        <button type="button" className="nc-btn ghost" onClick={copy} disabled={!rows.length}>{copied ? t('copied') : t('prefs-journal-copy')}</button>
        <button type="button" className="nc-btn ghost" onClick={clear} disabled={!rows.length}>{t('prefs-journal-clear')}</button>
      </div>
    </div>
  );
}
