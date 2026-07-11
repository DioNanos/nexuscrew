import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch, seenKey, fleetStatus, fleetUp, fleetDown, killSession, createSession, nodeAction,
} from '../lib/api.js';
import Icon from './Icon.jsx';
import { loadPins, togglePinIn, pinRank, cmpRank } from '../lib/pins.js';
import PowerSheet from './PowerSheet.jsx';
import NewSessionDialog from './NewSessionDialog.jsx';
import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useNodes } from '../hooks/useNodes.js';
import './SessionList.css';

// Home mobile: cockpit della flotta a gruppi (Flotta + Altre sessioni).
// Ordinamento per rilevanza (deliverable nuovi in outbox, poi attached, poi
// alfabetico) conservato dentro ciascun gruppo; filtro al volo oltre 8.
function relevance(s, fresh) {
  if (fresh) return 0;
  if (s.attached) return 1;
  return 2;
}

// Tempo relativo numerico (nessuna localizzazione, come da piano C3).
function rel(epochSec) {
  if (!epochSec) return '';
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Etichetta di stato di un gruppo nodo degradato (design §7: mai spinner).
function nodeStateLabel(g) {
  if (g.status === 'down') {
    return g.downSince ? t('tunnel-down-since').replace('{t}', rel(g.downSince)) : t('tunnel-down');
  }
  if (g.status === 'unreachable') return t('node-unreachable');
  if (g.status === 'offline') return g.lastSeen ? t('node-offline-seen').replace('{t}', rel(g.lastSeen)) : t('node-offline');
  if (g.status === 'needs-repair') return t('node-needs-repair');
  return '';
}

export default function SessionList({ onPick, token, onSettings }) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  // Gruppi per-nodo remoto (B2): zero nodi configurati -> [] e home identica.
  const nodeGroups = useNodes(token);
  const [sessions, setSessions] = useState(null); // null = primo load
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [version, setVersion] = useState('');
  const [endpoint, setEndpoint] = useState({ bind: '127.0.0.1', port: '' });
  const [cells, setCells] = useState([]);
  const [fleetAvailable, setFleetAvailable] = useState(false);
  const [engines, setEngines] = useState([]);       // dal contratto fleet ({id,label,rc})
  const [presets, setPresets] = useState(['shell', 'claude', 'codex-vl', 'pi']);
  const [powerCell, setPowerCell] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [nodeBusy, setNodeBusy] = useState(null);

  async function refresh() {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (j.error) { setErr(j.error); setSessions([]); }
      else { setErr(null); setSessions(j.sessions || []); }
    } catch (e) { setErr(String(e)); setSessions([]); }
    // flotta nello stesso interval del polling sessioni (4s)
    try {
      const fs = await fleetStatus(token);
      setFleetAvailable(!!fs.available);
      setCells(fs.available ? (fs.cells || []) : []);
      setEngines(fs.available ? (fs.engines || []) : []);
    } catch (_) { setFleetAvailable(false); setCells([]); setEngines([]); }
  }

  useEffect(() => {
    refresh();
    apiFetch('/api/config', token).then((r) => r.json())
      .then((j) => {
        setVersion(j.version || '');
        setEndpoint({ bind: j.bind || '127.0.0.1', port: j.port || '' });
        if (Array.isArray(j.presets) && j.presets.length) setPresets(j.presets);
      }).catch(() => {});
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  async function copyEndpointUrl() {
    if (!endpoint.port) return;
    const url = `http://${endpoint.bind}:${endpoint.port}/#token=${token}`;
    try { await navigator.clipboard.writeText(url); } catch (_) { /* clipboard non disponibile */ }
  }

  async function onFleetConfirm(payload) {
    if (!powerCell) return;
    const { cell } = powerCell;
    if (payload.action === 'up') await fleetUp(token, { cell, engine: payload.engine, model: payload.model || '', boot: !!payload.boot });
    else await fleetDown(token, { cell, boot: !!payload.boot });
    refresh();
  }

  async function onKill(name, route = []) {
    try { await killSession(token, name, route); } catch (_) { return; }
    refresh();
  }

  async function onCreate(body, route = []) {
    await createSession(token, body, route);
    setNewOpen(false);
    refresh();
  }

  async function onNodePower(group) {
    if (!group?.direct || nodeBusy) return;
    setNodeBusy(group.name);
    try { await nodeAction(token, group.name, group.tunnelStatus === 'up' ? 'down' : 'up'); }
    catch (_) {}
    setNodeBusy(null);
  }

  // lookup sessione per tmuxSession (per activity/preview/outbox delle celle)
  const byName = useMemo(() => {
    const m = new Map();
    for (const s of (sessions || [])) m.set(s.name, s);
    return m;
  }, [sessions]);

  const cellSessions = useMemo(() => new Set(cells.map((c) => c.tmuxSession)), [cells]);
  const [pins, setPins] = useState(loadPins);
  const togglePin = (name) => setPins((p) => togglePinIn(p, name));

  const rows = useMemo(() => {
    const list = (sessions || []).map((s) => {
      const seen = Number(localStorage.getItem(seenKey(s.name)) || 0);
      const fresh = !!(s.outbox && s.outbox.count > 0 && s.outbox.latest > seen);
      return { ...s, fresh };
    });
    const needle = q.trim().toLowerCase();
    return list
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .sort((a, b) => cmpRank(pinRank(pins, a.name, a.activity), pinRank(pins, b.name, b.activity))
        || relevance(a, a.fresh) - relevance(b, b.fresh) || a.name.localeCompare(b.name));
  }, [sessions, q, pins]);

  const others = rows.filter((s) => !cellSessions.has(s.name));
  const sortedCells = useMemo(
    () => [...cells].sort((a, b) =>
      cmpRank(pinRank(pins, a.tmuxSession, (byName.get(a.tmuxSession) || {}).activity),
              pinRank(pins, b.tmuxSession, (byName.get(b.tmuxSession) || {}).activity))
      || (Number(b.active) - Number(a.active)) || a.cell.localeCompare(b.cell)),
    [cells, pins, byName],
  );

  const total = sessions ? sessions.length : 0;
  const attached = (sessions || []).filter((s) => s.attached).length;
  const endpointLabel = endpoint.port ? `${endpoint.bind}:${endpoint.port}` : endpoint.bind;

  return (
    <div className="nc-home">
      <header className="nc-home-head">
        <div className="nc-wordmark">NexusCrew<span className="nc-cursor" /></div>
        <div className="nc-home-sub">
          {t('fleet-tmux')} · {total} {t('sessions')}{attached > 0 && ` · ${attached} attached`}
        </div>
        <span className="nc-head-actions">
          <button className="nc-refresh" onClick={onSettings} title={t('settings')}><Icon name="gear" size={18} /></button>
          <button className="nc-refresh" onClick={refresh} title={t('refresh')}><Icon name="refresh" size={18} /></button>
        </span>
      </header>

      {total > 8 && (
        <input
          className="nc-filter" type="search" placeholder={t('filter-placeholder')}
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      )}

      {err && <div className="nc-err">{err}</div>}

      {fleetAvailable && cells.length > 0 && (
        <section className="nc-group">
          <div className="nc-group-title">{t('fleet')}</div>
          {sortedCells.map((c) => {
            const s = byName.get(c.tmuxSession) || {};
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const sub = [`${c.engine}${c.key ? `·${c.key}` : ''}`, s.preview]
              .filter(Boolean).join(' · ');
            return (
              <div key={c.cell} className="nc-mcard">
                <button
                  className="nc-mcard-main"
                  onClick={() => c.tmux && onPick(c.tmuxSession)}
                  title={c.degraded ? t('cell-degraded') : c.tmux ? t('cell-on') : t('cell-off')}
                >
                  <span className={`dot ${dot}`} />
                  <span className="nc-mcard-text">
                    <b>{c.cell}</b>
                    <small>{sub}</small>
                  </span>
                </button>
                {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
                {s.outbox && s.outbox.count > 0 && (
                  <span className="nc-badge" title={t('new-files-outbox')}>{s.outbox.count}</span>
                )}
                <button
                  className={`nc-act pin${pins.includes(c.tmuxSession) ? ' on' : ''}`}
                  title={t('pin')}
                  onClick={() => togglePin(c.tmuxSession)}
                >{pins.includes(c.tmuxSession) ? '\u2605' : '\u2606'}</button>
                <button
                  className={`nc-act power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                  onClick={() => setPowerCell(c)}
                  title={c.active ? t('power-off') : t('power-on')}
                ><Icon name="power" size={16} /></button>
              </div>
            );
          })}
        </section>
      )}

      <section className="nc-group">
        <div className="nc-group-title">{t('local')}</div>
        {others.map((s) => (
          <div key={s.name} className="nc-mcard">
            <button className="nc-mcard-main" onClick={() => onPick(s.name)}>
              <span className={s.attached ? 'dot on' : 'dot'} />
              <span className="nc-mcard-text">
                <b>{s.name}</b>
                <small>{s.preview ? s.preview : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}</small>
              </span>
            </button>
            {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
            {s.fresh && <span className="nc-badge" title={t('new-files-outbox')}>{s.outbox.count}</span>}
            <button
              className={`nc-act pin${pins.includes(s.name) ? ' on' : ''}`}
              title={t('pin')}
              onClick={() => togglePin(s.name)}
            >{pins.includes(s.name) ? '\u2605' : '\u2606'}</button>
            <button
              className="nc-menu"
              title={t('terminate')}
              onClick={() => { if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill(s.name); }}
            >⋯</button>
          </div>
        ))}
        {sessions === null && <div className="nc-empty">{t('loading-fleet')}</div>}
        {sessions !== null && others.length === 0 && rows.length === 0 && !err && (
          <div className="nc-empty">
            {q ? t('no-match').replace('{q}', q) : t('no-sessions')}
          </div>
        )}
      </section>

      {/* Gruppi per-nodo remoto (B2, design §5): card per sessione remota;
          tunnel giu' = riga degradata statica (§7, niente spinner). */}
      {nodeGroups.map((g) => (
        <section key={`nodo-${(g.route || [g.name]).join('/')}`} className="nc-group">
          <div className="nc-group-title nc-node-title">
            <span className={`dot ${g.status === 'up' ? 'on' : 'warn'}`} />
            {g.label || g.name}
            {' · '}
            {g.status === 'up'
              ? t('node-sessions').replace('{n}', String(g.sessions.length))
              : nodeStateLabel(g)}
            {g.direct && <button type="button" className={`nc-act power${g.tunnelStatus === 'up' ? ' on' : ''}`}
              disabled={nodeBusy === g.name} title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
              onClick={() => onNodePower(g)}><Icon name="power" size={15} /></button>}
          </div>
          {g.status === 'up' && g.sessions.map((s) => (
            <div key={s.key} className="nc-mcard">
              <button className="nc-mcard-main" onClick={() => onPick({ session: s.name, node: s.node })}>
                <span className={s.attached ? 'dot on' : 'dot'} />
                <span className="nc-mcard-text">
                  <b>{s.name}</b>
                  <small>{s.preview ? s.preview : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}</small>
                </span>
              </button>
              {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
              <button className="nc-menu" title={t('terminate')}
                onClick={() => { if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill(s.name, g.route); }}>⋯</button>
            </div>
          ))}
          {g.status === 'up' && g.sessions.length === 0 && (
            <div className="nc-empty">{t('no-sessions-short')}</div>
          )}
        </section>
      ))}

      <footer className="nc-home-foot" onClick={copyEndpointUrl} title={t('copy-url')}>
        {version && <span>v{version}</span>}
        <span>{endpointLabel} · {t('ssh-only')}</span>
        <span className="nc-lang" onClick={(e) => e.stopPropagation()}>
          {LANGUAGES.map((lg, i) => (
            <span key={lg}>
              {i > 0 && ' · '}
              <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
            </span>
          ))}
        </span>
      </footer>

      <button className="nc-fab" onClick={() => setNewOpen(true)} title={t('new-session')} aria-label={t('new-session')}>+</button>

      {powerCell && (
        <PowerSheet cell={powerCell} engines={engines} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
      {newOpen && (
        <NewSessionDialog presets={presets} targets={nodeGroups.filter((g) => g.status === 'up').map((g) => ({ route: g.route, label: g.label || g.name }))}
          token={token} onCreate={onCreate} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}
