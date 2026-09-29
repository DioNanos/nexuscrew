import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';

// Su un telefono «ricorda» parte acceso: perdere il token a ogni riapertura e' peggio che tenerlo
// (il server e' comunque solo loopback/tunnel). Su desktop resta spento come prima.
export function defaultRemember() {
  try { if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true; } catch (_) { /* nessun matchMedia */ }
  try { return Number(globalThis.navigator && globalThis.navigator.maxTouchPoints) > 0; } catch (_) { return false; }
}

// Schermata del token. La BOZZA e' stato locale: il token entra nello stato dell'app (e nello storage)
// solo su «ok» o su Invio. Prima l'input chiamava setToken a ogni tasto: la schermata spariva al primo
// carattere e il bottone che scriveva nello storage non era mai raggiungibile.
export default function LoginScreen({ onSubmit, reason = '' }) {
  useLang();
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(defaultRemember);
  const value = draft.trim();
  const submit = (event) => {
    if (event && event.preventDefault) event.preventDefault();
    if (!value) return;
    onSubmit(value, remember);
  };
  return (
    <form className="nc-auth" onSubmit={submit}>
      <p>{t('auth-prompt')}</p>
      {reason === 'invalid' && <p className="nc-auth-error" role="alert">{t('auth-invalid')}</p>}
      <input
        type="text" value={draft} placeholder="token" aria-label="token"
        autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      <label>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t('remember-device')}
      </label>
      <button type="submit" disabled={!value}>ok</button>
    </form>
  );
}
