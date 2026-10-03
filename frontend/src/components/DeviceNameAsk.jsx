import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig } from '../lib/api.js';

// Quando il nome del dispositivo non è ricavabile
// dall'host (Termux/Android: «localhost») né ancora salvato, questo foglio
// lo CHIEDE una volta: campo semplice, salva in config (chiave deviceName).
// Nessun fallback generico: il campo resta vuoto finché l'utente non decide.
// «Più tardi» chiude per questa sessione (la domanda torna al prossimo
// avvio della PWA finché il nome non viene salvato).
export default function DeviceNameAsk({ token, suggestion = '', onSaved, onLater }) {
  useLang();
  const [nome, setNome] = useState(suggestion || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const salva = async () => {
    const value = nome.trim();
    if (!value) return;
    setBusy(true); setErr(null);
    try {
      await saveConfig(token, { deviceName: value });
      if (onSaved) onSaved(value);
    } catch (e) {
      setErr(String(e.message || e)); setBusy(false);
    }
  };

  return (
    <div className="nc-wiz-overlay" role="dialog" aria-label={t('device-name-ask-title')} data-testid="device-name-ask">
      <div className="nc-wiz">
        <div className="nc-wiz-head"><b>{t('device-name-ask-title')}</b></div>
        <div className="nc-wiz-body">
          <p className="nc-wiz-done">{t('device-name-ask-text')}</p>
          <label className="nc-field">
            <span>{t('device-name-label')}</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)}
              maxLength={64} data-testid="device-name-input" />
          </label>
          <div className="nc-sheet-actions">
            <button type="button" className="nc-btn ghost" disabled={busy} onClick={onLater}>{t('device-name-later')}</button>
            <button type="button" className="nc-btn primary" disabled={busy || !nome.trim()} onClick={salva}>{t('device-name-save')}</button>
          </div>
        </div>
        {err && <div className="nc-err">{err}</div>}
      </div>
    </div>
  );
}
