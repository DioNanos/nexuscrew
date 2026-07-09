import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './Sidebar.css';

// Tempo relativo compatto da epoch sec: 'ora' | 'Nm' | 'Nh' | 'Ng'.
function rel(epochSec) {
  if (!epochSec) return '';
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Sidebar presentazionale: mostra la flotta (celle) + le altre sessioni tmux.
// Il polling e le azioni sono del genitore; qui solo render + callback.
export default function Sidebar({ sessions = [], cells = [], activeSessions = [], onPick, onAddTile, onPower, onKill, onNew }) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  const cellSessions = new Set((cells || []).map((c) => c.tmuxSession));
  const others = (sessions || []).filter((s) => !cellSessions.has(s.name));
  const active = new Set(activeSessions || []);

  return (
    <aside className="nc-sidebar">
      <div className="nc-side-head">
        <span className="nc-side-title">{t('fleet')}</span>
        <button className="nc-new-btn" onClick={onNew} title={t('new-session')}>+ {t('new')}</button>
      </div>

      {(cells || []).length > 0 && (
        <div className="nc-side-group">
          {cells.map((c) => {
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const title = c.degraded ? t('cell-degraded') : c.tmux ? t('cell-on') : t('cell-off');
            return (
              <div key={c.cell} className="nc-cell" title={title}>
                <span className={`nc-dot ${dot}`} />
                <span className="nc-cell-main">
                  <b>{c.cell}</b>
                  <small>{c.engine}{c.key ? `·${c.key}` : ''}</small>
                </span>
                <button
                  className="nc-power"
                  onClick={() => onPower && onPower(c)}
                  title={c.active ? t('power-off') : t('power-on')}
                >⏻</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="nc-side-group-title">{t('other-sessions')}</div>
      <div className="nc-side-group">
        {others.map((s) => (
          <div
            key={s.name}
            className={`nc-side-card${active.has(s.name) ? ' active' : ''}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
            onClick={() => onAddTile && onAddTile(s.name)}
            onDoubleClick={() => onPick && onPick(s.name)}
          >
            <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
            <span className="nc-card-main">
              <b>{s.name}</b>
              <small>
                {s.preview
                  ? s.preview
                  : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}
                {s.outbox && s.outbox.count > 0 ? ` · 📦${s.outbox.count}` : ''}
              </small>
            </span>
            {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
            <button
              className="nc-menu"
              title={t('terminate')}
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name);
              }}
            >⋯</button>
          </div>
        ))}
        {others.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
      </div>

      <div className="nc-side-lang">
        {LANGUAGES.map((lg, i) => (
          <span key={lg}>
            {i > 0 && ' · '}
            <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
          </span>
        ))}
      </div>
    </aside>
  );
}
