import { useEffect, useRef, useState } from 'react';
import { t, LANGUAGES } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { pinRank, cmpRank } from '../lib/pins.js';
import {
  hostRenderState, hostNextAction, hostLeaseTitleKey, hostRouteKey,
} from '../lib/host-designation.js';
import PinPersistBanner from './PinPersistBanner.jsx';
import { sidebarItems, sidebarOrder } from '../lib/sidebar-model.js';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import { useNodePreferences } from '../hooks/useNodePreferences.js';
import {
  rel, nodeStateLabel, healthDot, healthTitle, buildLocalRoster, buildRemoteRoster,
} from '../lib/roster-view-model.js';
import { OWNER_ID_RE } from '../lib/grid-model.js';
import Icon from './Icon.jsx';
import CellPeek from './CellPeek.jsx';
import RosterHandle from './RosterHandle.jsx';
import './Sidebar.css';

// Iniziale compatta per la modalità mini (prima lettera significativa).
function initial(name) { return String(name || '?').replace(/^[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase() || '?'; }

// Larghezza sidebar: clamp 180–480px.
const SIDE_MIN_W = 180;
const SIDE_MAX_W = 480;
const bootCellKey = (cell, route = []) => `${route.length ? route.join('/') : 'local'}:${cell}`;

// Sidebar presentazionale: mostra la flotta (celle) + le altre sessioni tmux
// + i gruppi per-nodo remoto (B2, design §5). Il polling e le azioni sono del
// genitore; qui solo render + callback.
// Collassabile (mini 48px, solo dot) e ridimensionabile (maniglia bordo destro).
export default function Sidebar({
  sessions = [], cells = [], activeSessions = [], nodeGroups = [], onPick, onAddTile, onPower, onBoot, onNodePower, onKill, onVisibility, onNew,
  onNodeRename, onSettings, onBootError, localNodeId, fleetCapabilities = [], fleetStale = false, fleetOff = null, bootSettlement = null,
  hostByRoute = {}, onDesignateCell, onClearHostCell,
  onBootSettlementApplied, onOpenVlSession,
  // Il popup di sbirciata porta tre sorgenti: flusso e pannello chiedono il
  // token al server. La sidebar non lo aveva mai bisogno — ora sì.
  token = '',
  // UN solo popup alla volta: aprire il peek qui chiude l'overlay esterno
  // (lo switcher) tramite onPeekOpen; e se l'overlay esterno si apre, la
  // sidebar chiude il proprio peek (overlayOpen). Due overlay fissi
  // sovrapposti si contendono il fuoco e confondono l'utente.
  onPeekOpen,
  overlayOpen = false,
  width = 240, collapsed = false, onResize, onToggleCollapse,
}) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  const {
    pins, orders, togglePin, removePin, pinError, retryPinPersist, clearPinError, viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();
  const {
    groupsFor: preferredGroups, moveNode, stepNode, nodeKey,
  } = useNodePreferences();
  // Stato live del NODO che possiede `route` — mai quello di un altro nodo. La
  // designazione e' per-nodo lato server (CAS su una sola hostCell a testa);
  // hostByRoute e' la sua controparte lato client, una voce per route.
  const hostFor = (route) => hostByRoute[hostRouteKey(route)] || {};
  // Ciclo stellina: none -> favorite (pin) -> live (designate) -> none (clear
  // server + remove pin). API-first: il pin si rimuove SOLO a clear riuscito,
  // mai prima della risposta del server (nessun ottimismo locale). Vale per
  // QUALUNQUE nodo (locale o remoto): `route` e' quella del nodo che possiede
  // LA CELLA su cui si preme, non quella del nodo che serve la pagina — e'
  // esattamente la distinzione che il difetto originale ignorava.
  function handleStar(item, c, state, route) {
    const action = hostNextAction(state);
    if (action === 'addPin') { togglePin(item.key); return; }
    if (action === 'designate') { if (onDesignateCell) onDesignateCell(c.cell, route); return; }
    if (action === 'clearAndUnpin') {
      if (!onClearHostCell) return;
      // Rimozione idempotente (NON toggle): su uno stato server-owned senza pin
      // locale, un toggle aggiungerebbe il pin producendo "favorite". removePin
      // ritorna l'esito della persistenza: se fallisce lo segnaliamo (ritentabile);
      // lo stato UI e' gia' "none" perche' hostCell e' stato chiarito dal server.
      // removePin legge localStorage al momento dell'applicazione (no lost update)
      // e segnala un fallimento di persistenza nello stato (banner ritentabile).
      Promise.resolve(onClearHostCell(route)).then((ok) => { if (ok) removePin(item.key); });
    }
  }
  const cellSessions = new Set((cells || []).map((c) => c.tmuxSession));
  const byName = new Map((sessions || []).map((s) => [s.name, s]));
  // Ordinamento: pinnate in cima (ordine di pin), poi attivita' recente,
  // poi ordine naturale/alfabetico. Vale per ENTRAMBI i gruppi, celle incluse.
  const rank = (key, activity) => pinRank(pins, key, activity);
  const cmp = cmpRank;
  const sortedCells = [...(cells || [])].sort((a, b) =>
    cmp(rank(a.tmuxSession, (byName.get(a.tmuxSession) || {}).activity),
        rank(b.tmuxSession, (byName.get(b.tmuxSession) || {}).activity)));
  const others = (sessions || []).filter((s) => !cellSessions.has(s.name)).sort((a, b) => {
    const d = cmp(rank(a.name, a.activity), rank(b.name, b.activity));
    return d || a.name.localeCompare(b.name);
  });
  const active = new Set(activeSessions || []);
  // La sbirciata tiene una CHIAVE, mai la riga: la lista si aggiorna sotto e
  // una riga salvata sarebbe un fotogramma morto — il popup che mostra
  // l'anteprima di un'ALTRA cella creduta la propria è il difetto cercato in
  // R4 e chiuso lì. La chiave si ri-risolve a ogni render sulle righe correnti.
  const [peekKey, setPeekKey] = useState(null);
  const [peekSource, setPeekSource] = useState('preview');
  // Costruisce la riga-contratto di CellPeek da un item della sidebar.
  // CellPeek vuole: key, cellName, subtitle, nodeLabel, node, session, route,
  // panelUrl, telemetry, preview, activity. Le sorgenti flusso/pannello usano
  // session (tmuxSession reale) e node (route qualificata o '').
  // `byName` indicizza le sessioni di QUESTO nodo, e un tmuxSession non e'
  // unico nella federazione: lo stesso nome di sessione esiste su piu'
  // installazioni. Per una
  // cella REMOTA quella tabella risponderebbe con la sessione locale omonima,
  // e il popup mostrerebbe l'anteprima di un'ALTRA cella creduta la propria —
  // lo stesso difetto di R4, raggiunto per un'altra strada. Una riga remota si
  // risolve nelle sessioni DEL SUO nodo, come fa gia' SessionList: `route`
  // vuota = locale, ed e' gia' il criterio con cui questa funzione decide
  // `node` qui sotto. Senza le sessioni del nodo si resta ai dati che
  // viaggiano con la cella — mai a quelli di un omonimo locale.
  const peekRowFromItem = (item, c, route = [], nodeLabel = '', sessioniNodo = null) => {
    const locale = route.length === 0;
    const sessione = (locale
      ? byName.get(c.tmuxSession)
      : (sessioniNodo || []).find((s) => s && s.name === c.tmuxSession)) || {};
    return {
      key: item.key,
      cellName: c.cell,
      subtitle: item.subtitle || '',
      nodeLabel,
      node: route.length ? route.join('/') : '',
      session: c.tmuxSession,
      route,
      panelUrl: c.panelUrl || '',
      telemetry: sessione.telemetry || null,
      preview: sessione.preview || c.preview || '',
      activity: sessione.activity || c.activity || 0,
    };
  };
  const openPeek = (item, c, route = [], nodeLabel = '', source = 'preview') => (event) => {
    if (event) { event.stopPropagation(); }
    setPeekSource(source);
    setPeekKey(item.key);
    // UN solo popup: chiudo l'overlay esterno (switcher) se è aperto.
    if (typeof onPeekOpen === 'function') onPeekOpen();
  };
  // Se un overlay esterno si apre (switcher), il peek della sidebar si chiude:
  // due popup fissi sovrapposti sono il difetto che questa riga toglie.
  useEffect(() => { if (overlayOpen) { setPeekKey(null); setPeekSource('preview'); } }, [overlayOpen]);
  const localRawItems = buildLocalRoster(sortedCells, others, byName);
  const localItems = sidebarItems(localRawItems, pins, viewFor('local').filter, sidebarOrder(orders, 'local'));
  const preferredNodeGroups = preferredGroups(nodeGroups || []);
  const remoteRosters = preferredNodeGroups.map((g) => {
    // Un gruppo VL non è un roster tmux: la sua unica riga è la sessione
    // dichiarata dal device (sola lettura, si apre nella vista larga). Le
    // righe roster hanno semantiche kill/drag/tile che qui non esistono.
    const nodeRoute = (g.route && g.route.length ? g.route : [g.name]).join('/');
    const groupView = viewFor(nodeRoute);
    if (g.kind === 'vl') return { g, nodeRoute, groupView, rawItems: [], items: [] };
    const { rawItems } = buildRemoteRoster(g);
    const items = sidebarItems(rawItems, pins, groupView.filter, sidebarOrder(orders, nodeRoute));
    return { g, nodeRoute, groupView, rawItems, items };
  });
  // La riga sbirciata, cercata fra gli item locali e remoti per chiave. Se la
  // cella sparisce dalla lista, peekItem è null e il popup non si rende.
  const allCellItems = [
    ...localItems,
    ...remoteRosters.flatMap(({ items, nodeRoute, g }) => (items || []).map((it) => ({ ...it, nodeRoute, nodeLabel: g.label || g.name }))),
  ].filter((it) => it.type === 'cell');
  const peekItem = peekKey ? allCellItems.find((it) => it.key === peekKey) : null;
  const pickOwned = (session, node, ownerId) => onPick && onPick({
    session,
    ...(node ? { node } : {}),
    ...(OWNER_ID_RE.test(String(ownerId || '')) ? { ownerId } : {}),
  });
  const promptNodeRename = async (group) => {
    if (!group?.direct || !onNodeRename) return;
    const next = window.prompt(t('rename-node-prompt'), group.label || group.name);
    if (next === null) return;
    try {
      if (!await onNodeRename(group, next)) window.alert(t('rename-node-invalid'));
    } catch (error) { window.alert(String(error?.message || error)); }
  };
  // Override UI temporaneo: rende il toggle immediato mentre il polling locale
  // o Hydra converge. Quando il backend restituisce lo stesso valore, l'override
  // sparisce e la definizione Fleet torna unica source of truth.
  const [bootOverrides, setBootOverrides] = useState({});
  const [bootBusy, setBootBusy] = useState(new Set());
  useEffect(() => {
    const actual = new Map();
    for (const c of cells || []) actual.set(bootCellKey(c.cell), !!c.boot);
    for (const g of nodeGroups || []) {
      const route = g.route || [g.name];
      for (const c of g.cells || []) actual.set(bootCellKey(c.cell, route), !!c.boot);
    }
    setBootOverrides((current) => {
      let changed = false; const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        if (actual.has(key) && actual.get(key) === value) { delete next[key]; changed = true; }
      }
      return changed ? next : current;
    });
  }, [cells, nodeGroups]);
  // PowerSheet vive nel genitore App: una conferma deve sostituire subito
  // qualunque override ottimistico precedente per la stessa cella. Il poll
  // successivo rimuove l'override quando la definizione backend converge.
  useEffect(() => {
    if (!bootSettlement?.cell) return;
    const route = Array.isArray(bootSettlement.route) ? bootSettlement.route : [];
    const key = bootCellKey(bootSettlement.cell, route);
    setBootOverrides((current) => ({ ...current, [key]: !!bootSettlement.enabled }));
    if (onBootSettlementApplied) onBootSettlementApplied(bootSettlement.id);
  }, [bootSettlement, onBootSettlementApplied]);
  const bootEnabled = (c, route = []) => {
    const key = bootCellKey(c.cell, route);
    return Object.prototype.hasOwnProperty.call(bootOverrides, key) ? bootOverrides[key] : !!c.boot;
  };
  const toggleBoot = async (event, c, route = []) => {
    event.stopPropagation();
    if (!onBoot) return;
    const key = bootCellKey(c.cell, route); const enabled = !bootEnabled(c, route);
    setBootOverrides((current) => ({ ...current, [key]: enabled }));
    setBootBusy((current) => new Set(current).add(key));
    try {
      await onBoot(c.cell, enabled, route);
    } catch (error) {
      setBootOverrides((current) => { const next = { ...current }; delete next[key]; return next; });
      if (onBootError) onBootError(error);
    } finally {
      setBootBusy((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  const bootButton = (c, route = []) => {
    const key = bootCellKey(c.cell, route); const enabled = bootEnabled(c, route);
    const label = `${t(enabled ? 'boot-disable' : 'boot-enable')} ${c.cell}`;
    return (
      <button className={`nc-boot${enabled ? ' on' : ''}`} disabled={bootBusy.has(key)}
        onClick={(event) => toggleBoot(event, c, route)} title={label} aria-label={label}>
        <Icon name="boot" size={14} />
      </button>
    );
  };
  // Tooltip mini via JS (position:fixed): il ::after CSS veniva CLIPPATO
  // dall'overflow della sidebar da 48px.
  const [tip, setTip] = useState(null); // {text, y}
  const showTip = (e, text) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, y: r.top + r.height / 2 }); };
  const hideTip = () => setTip(null);
  // Cleanup listener resize su unmount (audit: come GridView).
  const resizeCleanupRef = useRef(null);
  useEffect(() => () => { if (resizeCleanupRef.current) resizeCleanupRef.current(); }, []);

  // Maniglia di resize sul bordo destro (pointer, come i divisori griglia).
  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (ev) => {
      const w = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, startW + (ev.clientX - startX)));
      onResize && onResize(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      resizeCleanupRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    resizeCleanupRef.current = up;
  }

  const style = collapsed
    ? { width: 48, flex: '0 0 48px' }
    : { width, flex: `0 0 ${width}px` };

  // --- modalità mini: solo dot celle + iniziali sessioni; click/drag attivi. ---
  if (collapsed) {
    return (
      <aside className="nc-sidebar mini" style={style}>
        <div className="nc-side-head mini">
          <button className="nc-collapse-btn" onClick={onToggleCollapse} title={t('expand')}>⟩</button>
        </div>
        <button className="nc-side-gear mini" onClick={() => onSettings && onSettings('nodes', false)} title={t('settings')}
          onMouseEnter={(e) => showTip(e, t('settings'))} onMouseLeave={hideTip}>
          <Icon name="gear" size={16} />
        </button>
        <div className="nc-side-scroll mini"><div className="nc-side-group mini">
          {viewFor('local').open && localItems.map((item) => item.type === 'cell' ? (() => {
            const c = item.value;
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const live = !!c.tmux;
            return (
              <button
                key={item.key}
                type="button"
                className={`nc-mini-dot${active.has(c.tmuxSession) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, `${c.cell}: ${item.subtitle}`)}
                onMouseLeave={hideTip}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : () => onPower && onPower(c)}
                onDoubleClick={live ? () => pickOwned(c.tmuxSession, '', localNodeId) : undefined}
              ><span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} /></button>
            );
          })() : (() => { const s = item.value; return (
            <button
              key={item.key}
              type="button"
              className={`nc-mini-init${active.has(s.name) ? ' active' : ''}`}
              onMouseEnter={(e) => showTip(e, s.name)}
              onMouseLeave={hideTip}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
              onClick={() => onAddTile && onAddTile(s.name)}
              onDoubleClick={() => pickOwned(s.name, '', localNodeId)}
            >{initial(s.name)}</button>
          ); })())}
          {/* Sessioni dei nodi remoti (B2): iniziali col tooltip "nodo:sessione";
              nodo degradato = dot warn statico (mai spinner, design §7). */}
          {remoteRosters.flatMap(({ g, nodeRoute, groupView, items }) => (g.kind === 'vl'
            ? (g.status === 'up' && g.sessions.length
              ? g.sessions.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="nc-mini-init"
                  onMouseEnter={(e) => showTip(e, `${g.label || nodeRoute}: ${s.name}`)}
                  onMouseLeave={hideTip}
                  onClick={() => onOpenVlSession && onOpenVlSession(g.peer)}
                >{initial(s.name)}</button>
              ))
              : [(
                <button
                  key={`nodo-vl-${nodeRoute}-${g.name}`}
                  type="button"
                  className="nc-mini-dot"
                  onMouseEnter={(e) => showTip(e, `${g.label || g.name}: ${g.status === 'up' ? t('no-sessions-short') : nodeStateLabel(g)}`)}
                  onMouseLeave={hideTip}
                ><span className={`nc-dot${g.status === 'up' ? ' on' : ' warn'}`} /></button>
              )])
            : g.status === 'up'
            ? (groupView.open ? items.map((item) => item.type === 'cell' ? (() => {
              const c = item.value; const live = !!c.tmux;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nc-mini-dot${active.has(item.key) ? ' active' : ''}`}
                  onMouseEnter={(e) => showTip(e, `${g.label || nodeRoute}: ${c.cell} · ${item.subtitle}`)}
                  onMouseLeave={hideTip}
                  draggable={live}
                  onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', item.key) : undefined}
                  onClick={live ? () => onAddTile && onAddTile(item.key) : () => onPower && onPower({ ...c, route: g.route, availableEngines: g.engines || [] })}
                  onDoubleClick={live ? () => pickOwned(c.tmuxSession, nodeRoute, g.instanceId) : undefined}
                ><span className={`nc-dot ${c.degraded ? 'warn' : live ? `on${item.working ? ' working' : ''}` : ''}`} /></button>
              );
            })() : (() => { const s = item.value; return (
              <button
                key={item.key}
                type="button"
                className={`nc-mini-init${active.has(item.key) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, `${g.label || nodeRoute}: ${s.name}`)}
                onMouseLeave={hideTip}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/nc-session', item.key)}
                onClick={() => onAddTile && onAddTile(item.key)}
                onDoubleClick={() => pickOwned(s.name, nodeRoute, g.instanceId)}
              >{initial(s.name)}</button>
            ); })()) : [])
            : [(
              <button
                key={`nodo-${(g.route || [g.name]).join('/')}`}
                type="button"
                className="nc-mini-dot"
                onMouseEnter={(e) => showTip(e, `${g.label || (g.route || [g.name]).join(' › ')}: ${nodeStateLabel(g)}`)}
                onMouseLeave={hideTip}
              ><span className={`nc-dot${g.status === 'passive' ? '' : ' warn'}`} /></button>
            )]))}
        </div></div>
        {tip && <div className="nc-mini-tip" style={{ top: tip.y }}>{tip.text}</div>}
      </aside>
    );
  }

  // MODALITÀ MINI (sidebar collassata a 48px): il pallino È tutta la riga e
  // fa onAddTile/onPower. Non c'è spazio per due bersagli distinti: un bottone
  // da otto pixel accanto al dot sarebbe un bersaglio peggiore del gesto che
  // c'è. Scelta dichiarata (briefing): in mini resti COM'È. La sbirciata si
  // apre dall'espanso, quando l'utente allarga la sidebar.

  return (
    <aside className="nc-sidebar" style={style}>
      <div className="nc-side-head">
        <button className="nc-collapse-btn" onClick={onToggleCollapse} title={t('collapse')}>⟨</button>
        <span className="nc-side-title">{t('fleet')}</span>
        {/* R27: lettura fleet non riuscita → la lista e' l'ultima nota, non un dato */}
        {fleetStale && <span className="nc-side-fleet-stale" role="status" title={t('fleet-stale')} aria-label={t('fleet-stale')}>●</span>}
        {/* R27 rev3: fleet spento per scelta → zero celle e' la verita' (reason del server) */}
        {fleetOff !== null && (
          <span className="nc-side-fleet-off" role="status"
            title={`${t('fleet-off')}${fleetOff ? ` (${fleetOff})` : ''}`}
            aria-label={`${t('fleet-off')}${fleetOff ? ` (${fleetOff})` : ''}`}>○</span>
        )}
        <button className="nc-new-btn" onClick={onNew} title={t('fleet-new-cell')}>+ {t('new')}</button>
      </div>

      <button className="nc-side-gear" onClick={() => onSettings && onSettings('nodes', false)} title={t('settings')}>
        <Icon name="gear" size={15} /> {t('settings')}
      </button>

      <PinPersistBanner pinError={pinError} onRetry={retryPinPersist} onDismiss={clearPinError} />

      <div className="nc-side-scroll">
      <PositionHeader
        label={t('position-local')}
        count={localItems.length}
        state={viewFor('local')}
        onToggle={() => updateView('local', { open: !viewFor('local').open })}
        onFilter={(filter) => updateView('local', { filter })}
      />
      {viewFor('local').open && (
        <div className="nc-side-group">
          {localItems.map((item) => item.type === 'cell' ? (() => {
            const c = item.value;
            const host = hostFor([]);
            const starState = hostRenderState({ hostCell: host.hostCell ?? null, pins, item });
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            // Sull'host designato il titolo porta anche lo stato del lease: dice
            // se dietro la designazione c'e' ancora una supervisione viva. Senza
            // stato (server che non lo espone) non si aggiunge nulla — mai una
            // bugia per riempire lo spazio.
            const leaseKey = hostLeaseTitleKey(starState, host.hostLease ?? null);
            const baseTitle = c.degraded
              ? t('cell-degraded')
              : item.working ? item.subtitle : c.tmux ? t('cell-idle') : t('cell-off');
            const title = leaseKey ? `${baseTitle} · ${t(leaseKey)}` : baseTitle;
            // Cella con tmux vivo = sessione a tutti gli effetti: draggabile
            // nella griglia, click = tile, doppio click = vista singola.
            const live = !!c.tmux;
            return (
              <div
                key={item.key}
                data-roster-key={item.key}
                data-position="local"
                className={`nc-cell${live ? ' live' : ''}${active.has(c.tmuxSession) ? ' active' : ''}`}
                title={`${c.cell} · ${item.subtitle}${title === item.subtitle ? '' : ` · ${title}`}`}
                aria-label={`${c.cell}, ${item.subtitle}${title === item.subtitle ? '' : `, ${title}`}`}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : undefined}
                onDoubleClick={live ? () => pickOwned(c.tmuxSession, '', localNodeId) : undefined}
              >
                <RosterHandle position="local" itemKey={item.key} label={c.cell}
                  canMove={canMoveRoster}
                  onMove={(source, target) => moveRoster('local', source, target, localRawItems)}
                  onStep={(delta) => stepRoster('local', item.key, delta, localRawItems)} />
                {/* Il pallino è un bersaglio SUO: apre la sbirciata (CellPopup,
                    tre sorgenti) senza aggiungere la tile. stopPropagation
                    ferma l'onClick della riga — la non-regressione del gesto
                    che c'è (riga → tile, doppio clic → vista singola). Su
                    cella spenta resta decorativo: niente popup su chi non
                    risponde. */}
                {live ? (
                  <button
                    type="button"
                    className="nc-side-peek"
                    title={t('cell-peek')}
                    aria-label={`${t('cell-peek')}: ${c.cell}`}
                    onClick={openPeek(item, c, [], '')}
                  ><span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} /></button>
                ) : (
                  <span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} />
                )}
                <span className="nc-cell-main">
                  <b title={c.cell}>{c.cell}</b>
                  <small title={item.subtitle}>{item.subtitle}</small>
                </span>
                <button
                  className={`nc-pin${starState === 'live' ? ' live' : starState === 'favorite' ? ' on' : ''}`}
                  title={starState === 'live' ? 'live host' : t('pin')}
                  onClick={(e) => { e.stopPropagation(); handleStar(item, c, starState, []); }}
                >{starState === 'none' ? '☆' : '★'}</button>
                {onBoot && fleetCapabilities.includes('boot') && bootButton(c)}
                <button
                  className={`nc-power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onPower && onPower({ ...c, boot: bootEnabled(c) }); }}
                  title={c.active ? t('power-off') : t('power-on')}
                ><Icon name="power" size={14} /></button>
              </div>
            );
          })() : (() => {
            const s = item.value;
            return <div
              key={item.key}
              data-roster-key={item.key}
              data-position="local"
              className={`nc-side-card${active.has(s.name) ? ' active' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
              onClick={() => onAddTile && onAddTile(s.name)}
              onDoubleClick={() => pickOwned(s.name, '', localNodeId)}
            >
              <RosterHandle position="local" itemKey={item.key} label={s.name}
                canMove={canMoveRoster}
                onMove={(source, target) => moveRoster('local', source, target, localRawItems)}
                onStep={(delta) => stepRoster('local', item.key, delta, localRawItems)} />
              <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
              <span className="nc-card-main"><b>{s.name}</b><small>{s.preview || s.cmd || t('windows').replace('{n}', String(s.windows || 0))}{s.outbox?.count > 0 ? ` · 📦${s.outbox.count}` : ''}</small></span>
              {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
              <button className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`} title={t('pin')}
                onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}>{pins.includes(item.key) ? '★' : '☆'}</button>
              <button className={`nc-technical${s.technical ? ' on' : ''}`}
                title={s.technical ? t('mark-normal') : t('mark-technical')}
                aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
                onClick={(e) => { e.stopPropagation(); onVisibility && onVisibility(s.name, !s.technical, []); }}>T</button>
              <button className="nc-menu" title={t('terminate')} onClick={(e) => { e.stopPropagation(); if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name); }}>⋯</button>
            </div>;
          })())}
          {localItems.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
        </div>
      )}

      {/* Gruppi per-nodo remoto (Hydra): per ogni posizione celle Fleet (attive e
          inattive, draggabili se live) + tmux unmanaged. Salute dal probe federato
          (NO verde hardcoded): 401/degraded -> warn + diagnostica. Power del tunnel
          solo per nodi diretti gestibili; peer inbound non ha power fittizio. */}
      {remoteRosters.map(({ g, nodeRoute, groupView, rawItems, items: remoteItems }) => {
        const hd = healthDot(g.health);
        const dotClass = hd || (g.status === 'up' ? 'on' : g.status === 'passive' ? '' : 'warn');
        // Gruppo nodo VL (VL_NODES_IN_SIDEBAR): stesso posto degli altri nodi,
        // conteggio onesto (1 se il device dichiara l'attach, 0 altrimenti);
        // offline mostra cio' che mostrano gli altri nodi offline. La riga
        // sessione apre la vista eventi nella vista larga (la sua sede), non
        // un terminale: niente drag, niente kill, niente pin.
        if (g.kind === 'vl') {
          return (
            <div key={`nodo-vl-${nodeRoute}-${g.name}`} className="nc-node-order-wrap"
              data-node-order-key={nodeKey(g)}>
              <div className="nc-side-group-title nc-node-title" role="button" tabIndex={0}
                onClick={() => updateView(nodeRoute, { open: !groupView.open })}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateView(nodeRoute, { open: !groupView.open }); } }}>
                <RosterHandle scope="node" position="nodes" itemKey={nodeKey(g)} label={g.label || g.name}
                  onMove={(source, target) => moveNode(source, target, nodeGroups || [])}
                  onStep={(delta) => stepNode(nodeKey(g), delta, nodeGroups || [])} />
                <span className="nc-node-chevron">{groupView.open ? '⌄' : '›'}</span>
                <span className={`nc-dot ${dotClass}`} title={g.health ? healthTitle(g.health) : ''} />
                <b>{g.label || g.name}</b>
                <small>
                  {' · '}
                  {g.status === 'up'
                    ? t('node-sessions').replace('{n}', String(g.sessions.length))
                    : nodeStateLabel(g)}
                </small>
              </div>
              {g.status === 'up' && groupView.open && (
                <div className="nc-side-group">
                  {g.sessions.map((s) => (
                    <div key={s.key} className="nc-side-card nc-vl-session-row" role="button" tabIndex={0}
                      onClick={() => onOpenVlSession && onOpenVlSession(g.peer)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenVlSession && onOpenVlSession(g.peer); } }}>
                      <span className="nc-dot on" />
                      <span className="nc-card-main"><b>{s.name}</b><small>{t('vl-events-title')}</small></span>
                    </div>
                  ))}
                  {g.sessions.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
                </div>
              )}
            </div>
          );
        }
        return (
        <div key={`nodo-${(g.route || [g.name]).join('/')}`} className="nc-node-order-wrap"
          data-node-order-key={nodeKey(g)}>
          <div className="nc-side-group-title nc-node-title" role="button" tabIndex={0}
            onContextMenu={g.direct && onNodeRename ? (e) => { e.preventDefault(); promptNodeRename(g); } : undefined}
            onClick={() => updateView(nodeRoute, { open: !groupView.open })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateView(nodeRoute, { open: !groupView.open }); } }}>
            <RosterHandle scope="node" position="nodes" itemKey={nodeKey(g)} label={g.label || g.name}
              onMove={(source, target) => moveNode(source, target, nodeGroups || [])}
              onStep={(delta) => stepNode(nodeKey(g), delta, nodeGroups || [])} />
            <span className="nc-node-chevron">{groupView.open ? '⌄' : '›'}</span>
            <span className={`nc-dot ${dotClass}`} title={g.health ? healthTitle(g.health) : ''} />
            <b>{g.label || g.name}</b>
            <small>
              {' · '}
              {g.status === 'up'
                ? t('node-sessions').replace('{n}', String(remoteItems.length))
                : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            </small>
            <select className="nc-node-filter" value={groupView.filter} title={t(`view-${groupView.filter}`)}
              onClick={(e) => e.stopPropagation()} onChange={(e) => updateView(nodeRoute, { filter: e.target.value })}>
              <option value="all">{t('view-all')}</option><option value="pinned">{t('view-pinned')}</option>
              <option value="active">{t('view-active')}</option><option value="off">{t('view-off')}</option><option value="technical">{t('view-technical')}</option>
            </select>
            {g.direct && onNodeRename && <button type="button" className="nc-node-rename" title={t('rename-node')}
              aria-label={`${t('rename-node')} ${g.label || g.name}`}
              onClick={(e) => { e.stopPropagation(); promptNodeRename(g); }}>✎</button>}
            {g.direct && g.health && g.health.managed !== false && (
              <button type="button" className={`nc-power${g.tunnelStatus === 'up' ? ' on' : ''}`}
                title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
                onClick={(e) => { e.stopPropagation(); onNodePower && onNodePower(g); }}><Icon name="power" size={14} /></button>
            )}
          </div>
          {g.status === 'up' && groupView.open && (
            <div className="nc-side-group">
              {remoteItems.map((item) => item.type === 'cell' ? (() => {
                const c = item.value;
                const route = g.route || [g.name];
                const host = hostFor(route);
                const starState = hostRenderState({ hostCell: host.hostCell ?? null, pins, item });
                const leaseKey = hostLeaseTitleKey(starState, host.hostLease ?? null);
                const live = !!c.tmux;
                const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
                const baseTitle = item.working ? item.subtitle : c.tmux ? t('cell-idle') : t('cell-off');
                const cardTitle = leaseKey ? `${baseTitle} · ${t(leaseKey)}` : baseTitle;
                return (
                  <div
                    key={item.key}
                    data-roster-key={item.key}
                    data-position={nodeRoute}
                    className={`nc-side-card nc-cell${live ? ' live' : ''}${active.has(c.key) ? ' active' : ''}`}
                    title={cardTitle}
                    draggable={live}
                    onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.key) : undefined}
                    onClick={live ? () => onAddTile && onAddTile(c.key) : undefined}
                    onDoubleClick={live ? () => pickOwned(c.tmuxSession, nodeRoute, g.instanceId) : undefined}
                  >
                    <RosterHandle position={nodeRoute} itemKey={item.key} label={c.cell}
                      canMove={canMoveRoster}
                      onMove={(source, target) => moveRoster(nodeRoute, source, target, rawItems)}
                      onStep={(delta) => stepRoster(nodeRoute, item.key, delta, rawItems)} />
                    {live ? (
                      <button
                        type="button"
                        className="nc-side-peek"
                        title={t('cell-peek')}
                        aria-label={`${t('cell-peek')}: ${c.cell}`}
                        onClick={openPeek(item, c, g.route || [g.name], g.label || g.name)}
                      ><span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} /></button>
                    ) : (
                      <span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} />
                    )}
                    <span className="nc-card-main">
                      <b>{c.cell}</b>
                      <small title={item.subtitle}>{item.subtitle}</small>
                    </span>
                    <button
                      className={`nc-pin${starState === 'live' ? ' live' : starState === 'favorite' ? ' on' : ''}`}
                      title={starState === 'live' ? 'live host' : t('pin')}
                      onClick={(e) => { e.stopPropagation(); handleStar(item, c, starState, route); }}
                    >{starState === 'none' ? '☆' : '★'}</button>
                    {onBoot && (g.capabilities || []).includes('boot') && bootButton(c, g.route || [])}
                    {(g.capabilities || []).includes(c.active ? 'down' : 'up') && (
                      <button className={`nc-power${c.active ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPower && onPower({
                            ...c,
                            boot: bootEnabled(c, g.route || []),
                            route: g.route,
                            availableEngines: g.engines || [],
                          });
                        }}
                        title={c.active ? t('power-off') : t('power-on')}><Icon name="power" size={14} /></button>
                    )}
                  </div>
                );
              })() : (() => { const s = item.value; return (
                <div
                  key={item.key}
                  data-roster-key={item.key}
                  data-position={nodeRoute}
                  className={`nc-side-card${active.has(s.key) ? ' active' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.key)}
                  onClick={() => onAddTile && onAddTile(s.key)}
                  onDoubleClick={() => pickOwned(s.name, s.node || nodeRoute, g.instanceId)}
                >
                  <RosterHandle position={nodeRoute} itemKey={item.key} label={s.name}
                    canMove={canMoveRoster}
                    onMove={(source, target) => moveRoster(nodeRoute, source, target, rawItems)}
                    onStep={(delta) => stepRoster(nodeRoute, item.key, delta, rawItems)} />
                  <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
                  <span className="nc-card-main">
                    <b>{s.name}</b>
                    <small>
                      {s.preview
                        ? s.preview
                        : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}
                    </small>
                  </span>
                  {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
                  <button className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`} title={t('pin')}
                    onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}>{pins.includes(item.key) ? '★' : '☆'}</button>
                  <button className={`nc-technical${s.technical ? ' on' : ''}`}
                    title={s.technical ? t('mark-normal') : t('mark-technical')}
                    aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
                    onClick={(e) => { e.stopPropagation(); onVisibility && onVisibility(s.name, !s.technical, g.route || []); }}>T</button>
                  <button className="nc-menu" title={t('terminate')} onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name, g.route);
                  }}>⋯</button>
                </div>
              ); })())}
              {remoteItems.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
            </div>
          )}
        </div>
        );
      })}

      </div>

      <div className="nc-side-lang">
        {LANGUAGES.map((lg, i) => (
          <span key={lg}>
            {i > 0 && ' · '}
            <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
          </span>
        ))}
      </div>

      <div className="nc-side-resize" onPointerDown={startResize} title="" />

      {/* La sbirciata, solo in modalità espansa (in mini non c'è spazio per
          due bersagli: vedi scelta sopra). peekItem null = cella sparita
          dalla lista aggiornata → il popup non si rende, come in R4. */}
      {peekItem && (() => {
        const c = peekItem.value;
        const gruppo = peekItem.nodeRoute
          ? (nodeGroups.find((g) => (g.route || [g.name]).join('/') === peekItem.nodeRoute) || {})
          : null;
        const route = peekItem.nodeRoute ? (gruppo.route || [peekItem.nodeRoute]) : [];
        return (
          <CellPeek
            row={peekRowFromItem(peekItem, c, route, peekItem.nodeLabel || '', gruppo && gruppo.sessions)}
            token={token}
            initialSource={peekSource}
            onClose={() => { setPeekKey(null); setPeekSource('preview'); }}
          />
        );
      })()}
    </aside>
  );
}

function PositionHeader({ label, count, state, onToggle, onFilter }) {
  return <div className="nc-side-group-title nc-node-title" role="button" tabIndex={0}
    onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
    <span className="nc-node-chevron">{state.open ? '⌄' : '›'}</span>
    <span className="nc-dot on" /><b>{label}</b><small> · {t('node-sessions').replace('{n}', String(count))}</small>
    <select className="nc-node-filter" value={state.filter} title={t(`view-${state.filter}`)}
      onClick={(e) => e.stopPropagation()} onChange={(e) => onFilter(e.target.value)}>
      <option value="all">{t('view-all')}</option><option value="pinned">{t('view-pinned')}</option>
      <option value="active">{t('view-active')}</option><option value="off">{t('view-off')}</option><option value="technical">{t('view-technical')}</option>
    </select>
  </div>;
}
