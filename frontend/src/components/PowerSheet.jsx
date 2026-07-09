import { useState } from 'react';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './PowerSheet.css';

// Engine allowlistati (specchia lib/fleet/index.js ENGINES).
const ENGINES = ['native', 'glm', 'glm-a', 'glm-p', 'ollama', 'ollama-cloud', 'codex-vl'];

// Sheet di accensione/spegnimento di una cella.
//   cell: oggetto cella flotta ({cell, engine, active, boot, ...})
//   onConfirm(payload): il genitore esegue fleetUp/fleetDown — payload:
//     {action:'up', engine, boot} | {action:'down', boot}  (boot down = togli dal boot)
// Vincolo: engine ≠ native → niente remote-control (mostrato).
export default function PowerSheet({ cell, onConfirm, onClose }) {
  useLang();
  const isOn = !!(cell && cell.active);
  const [engine, setEngine] = useState(cell?.engine || 'glm');
  const [boot, setBoot] = useState(cell?.boot ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (isOn) await onConfirm({ action: 'down', boot });
      else await onConfirm({ action: 'up', engine, boot });
      onClose();
    } catch (er) { setErr(String((er && er.message) || er)); setBusy(false); }
  }

  return (
    <div className="nc-sheet-overlay" onClick={onClose}>
      <form className="nc-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="nc-sheet-head">
          <b>{cell?.cell}</b>
          <span className="nc-sheet-state">{isOn ? t('state-on') : t('state-off')}</span>
        </div>

        {isOn ? (
          <label className="nc-check">
            <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
            {t('remove-boot')}
          </label>
        ) : (
          <>
            <div className="nc-sheet-label">{t('engine')}</div>
            <div className="nc-engines">
              {ENGINES.map((en) => (
                <label key={en} className={`nc-engine${engine === en ? ' sel' : ''}`}>
                  <input type="radio" name="ps-engine" checked={engine === en} onChange={() => setEngine(en)} />
                  {en}
                </label>
              ))}
            </div>
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('boot-persist')}
            </label>
            {engine !== 'native' && (
              <div className="nc-note">{t('no-remote-control')}</div>
            )}
          </>
        )}

        {err && <div className="nc-err">{err}</div>}

        <div className="nc-sheet-actions">
          <button type="button" className="nc-btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="nc-btn primary" disabled={busy}>
            {isOn ? t('power-off') : t('power-on')}
          </button>
        </div>
      </form>
    </div>
  );
}
