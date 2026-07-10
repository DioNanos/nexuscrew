import { useState } from 'react';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './PowerSheet.css';

// Sheet di accensione/spegnimento di una cella.
//   cell: oggetto cella flotta ({cell, engine, active, boot, ...})
//   engines: dal contratto fleet ({id, label, rc}) — niente lista hardcoded;
//     l'ordine è quello dichiarato dal fleet (primo = default consigliato).
//   onConfirm(payload): il genitore esegue fleetUp/fleetDown — payload:
//     {action:'up', engine, boot} | {action:'down', boot}  (boot down = togli dal boot)
// Vincolo: engine senza rc → niente remote-control app claude.ai (mostrato).
export default function PowerSheet({ cell, engines = [], onConfirm, onClose }) {
  useLang();
  const isOn = !!(cell && cell.active);
  // Fallback se il fleet non dichiara engines: almeno quello corrente della cella.
  const list = engines.length ? engines
    : [{ id: cell?.engine || 'native', label: cell?.engine || 'native', rc: (cell?.engine || 'native') === 'native' }];
  const [engine, setEngine] = useState(cell?.engine || list[0].id);
  const sel = list.find((e) => e.id === engine);
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
              {list.map((en) => (
                <label key={en.id} className={`nc-engine${engine === en.id ? ' sel' : ''}`}>
                  <input type="radio" name="ps-engine" checked={engine === en.id} onChange={() => setEngine(en.id)} />
                  {en.label}
                  {en.label.toLowerCase() !== en.id.toLowerCase() && <small className="nc-engine-id"> ({en.id})</small>}
                </label>
              ))}
            </div>
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('boot-persist')}
            </label>
            {sel && !sel.rc && (
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
