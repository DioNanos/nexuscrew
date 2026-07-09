import { useState } from 'react';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './NewSessionDialog.css';

// Validazione nome specchiata da lib/tmux/lifecycle.js validSessionName.
const NAME_RE = /^[\w.-]{1,64}$/;

// Dialog nuova sessione. presets arriva da /api/config (B3 Step 1).
//   onCreate({name, cwd, preset}): il genitore chiama createSession().
// Nota: cwd default '~' → inviamo '' così il server usa la home reale
// (resolveCwd non espande '~'; un path reale passa invariato).
export default function NewSessionDialog({ presets = ['shell'], onCreate, onClose }) {
  useLang();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('~');
  const [preset, setPreset] = useState(presets[0] || 'shell');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const nameOk = NAME_RE.test(name) && !name.startsWith('-');

  async function submit(e) {
    e.preventDefault();
    if (!nameOk) return;
    setBusy(true); setErr(null);
    try {
      await onCreate({
        name,
        cwd: cwd === '~' ? '' : cwd,
        preset,
      });
      onClose();
    } catch (er) { setErr(String((er && er.message) || er)); setBusy(false); }
  }

  return (
    <div className="nc-sheet-overlay" onClick={onClose}>
      <form className="nc-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="nc-sheet-head"><b>{t('new-session')}</b></div>

        <label className="nc-field">{t('name')}
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            autoFocus placeholder="worker-1"
          />
        </label>
        {name && !nameOk && (
          <div className="nc-err">{t('name-invalid')}</div>
        )}

        <label className="nc-field">{t('cwd')}
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
        </label>

        <label className="nc-field">{t('preset')}
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {presets.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        {err && <div className="nc-err">{err}</div>}

        <div className="nc-sheet-actions">
          <button type="button" className="nc-btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="nc-btn primary" disabled={busy || !nameOk}>{t('create')}</button>
        </div>
      </form>
    </div>
  );
}
