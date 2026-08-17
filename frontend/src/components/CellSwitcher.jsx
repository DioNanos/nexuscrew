import { useEffect, useMemo, useRef, useState } from 'react';
import CellPopup from './CellPopup.jsx';
import Terminal from './Terminal.jsx';
import CellPanel from './CellPanel.jsx';
import { apiFetch, fleetStatus, getRouteSessions } from '../lib/api.js';
import { readCellSwitcherSnapshot, writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { buildLocalRoster, buildRemoteRoster, cellRuntime } from '../lib/roster-view-model.js';
import { positionKey } from '../lib/nodes-model.js';
import { sidebarItems, sidebarOrder } from '../lib/sidebar-model.js';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import RosterHandle from './RosterHandle.jsx';
import { panelPortForRoute } from '../lib/panel-port.js';
import { t } from '../lib/i18n.js';
import './CellSwitcher.css';

const POLL_MS = 4000;

// Quanto è passata dall'ultima attività della cella, dette le stesse tre
// regole della telemetria: assenza legittima (niente epoch = niente campo),
// niente stantio spacciato per fresco (oltre la soglia il campo sparisce: una
// cella ferma da ore non mostra «5m» per sempre), degradazione silenziosa.
// L'unità compatta (m/h) è la stessa in ogni lingua: si traduce solo l'etichetta.
const ATTIVITÀ_MASSIMA_MS = 30 * 60 * 1000;

export function formattaAttività(t, epoch, oraMs = Date.now()) {
  const ms = Number(epoch);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const età = oraMs - ms;
  if (età < 0 || età > ATTIVITÀ_MASSIMA_MS) return '';
  // L'etichetta c'è sempre: un «2m» nudo accanto alla telemetria non dice
  // cosa stia misurando, e una riga che non si spiega viene letta male.
  if (età < 60 * 1000) return `${t('cell-activity')} ${t('cell-activity-now')}`;
  const minuti = Math.floor(età / 60000);
  if (minuti < 60) return `${t('cell-activity')} ${minuti}m`;
  return `${t('cell-activity')} ${Math.floor(minuti / 60)}h`;
}

// La telemetria di riga, dove la cella la pubblica. Il VERSO è scritto nel
// testo stesso di OGNI numero: il contesto è «libero», i tier sono «usati».
// Non basta che il verso stia nei nomi del contratto (contextFreePct /
// tier*UsedPct): chi legge vede solo questa riga — un numero senza il suo
// verso prenderebbe per contagio quello del vicino («contesto 71% libero ·
// 5h 33%» si legge tutto libero). Ogni etichetta dice il proprio.
// Campi mancanti → la riga mostra quelli che ci sono; nessun campo → stringa
// vuota e la riga resta com'era (celle non-Claude: assenza legittima).
export function formattaTelemetria(t, tele) {
  if (!tele || typeof tele !== 'object') return '';
  const parti = [];
  if (Number.isInteger(tele.contextFreePct)) {
    parti.push(`${t('cell-tele-ctx')} ${tele.contextFreePct}% ${t('cell-tele-free')}`);
  }
  if (Number.isInteger(tele.tier5hUsedPct)) parti.push(`${t('cell-tele-5h')} ${tele.tier5hUsedPct}%`);
  if (Number.isInteger(tele.tier7dUsedPct)) parti.push(`${t('cell-tele-7d')} ${tele.tier7dUsedPct}%`);
  return parti.join(' · ');
}

async function localSessions(token) {
  const response = await apiFetch('/api/sessions', token);
  if (response?.ok === false) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.sessions)) throw new Error('invalid sessions payload');
  return payload.sessions;
}

async function readPosition(token, route = []) {
  const [sessionsResult, fleetResult] = await Promise.allSettled([
    route.length ? getRouteSessions(token, route) : localSessions(token),
    fleetStatus(token, route),
  ]);
  const sessions = sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value?.sessions)
    ? sessionsResult.value.sessions
    : (Array.isArray(sessionsResult.value) ? sessionsResult.value : null);
  const fleet = fleetResult.status === 'fulfilled' ? fleetResult.value : null;
  const cells = fleet?.available === true && Array.isArray(fleet.cells) ? fleet.cells : null;
  return { sessions, cells, fresh: Array.isArray(sessions) && Array.isArray(cells) };
}

function isActiveCell(cell, sessions, fresh) {
  return fresh === true && cell?.degraded !== true && cell?.active === true && cell.tmux !== false
    && !!cell.tmuxSession && (sessions || []).some((session) => session?.name === cell.tmuxSession);
}

function rowsFromSnapshot(snapshot) {
  const localSessions = new Map((snapshot.sessions || []).map((entry) => [entry.name, entry]));
  const rows = [];
  const addCells = (cells, sessions, fresh, route = [], nodeLabel = '') => {
    const byName = new Map((sessions || []).map((entry) => [entry.name, entry]));
    for (const cell of cells || []) {
      const session = byName.get(cell.tmuxSession) || {};
      const runtime = cellRuntime(cell, session);
      const selectable = isActiveCell(cell, sessions, fresh);
      rows.push({
        // Deve corrispondere a SessionList: il locale non ha prefisso, le
        // route remote restano qualificate. Cosi' pin e ordine sono condivisi.
        key: positionKey(route, cell.tmuxSession || cell.cell),
        session: cell.tmuxSession,
        route,
        cellName: cell.cell,
        label: cell.cell,
        node: route.length ? route.join('/') : '',
        nodeLabel,
        live: selectable,
        selectable,
        // `verified` e' la conferma di questo poll. Non usare `fresh`: nel
        // roster condiviso significa invece output nuovo e ordina le righe.
        verified: fresh === true,
        working: runtime.working,
        degraded: !!cell.degraded,
        active: cell.active === true,
        activity: session.activity || cell.activity || 0,
        subtitle: runtime.subtitle,
        // Il preview esisteva gia' nel roster e non arrivava alla riga: il
        // popup lo mostra, senza chiedere nulla di nuovo al server.
        preview: session.preview || cell.preview || '',
        // Contesto libero e tier usati, se la cella li pubblica. Null per le
        // non-Claude: la riga non mostra nulla, com'era prima.
        telemetry: session.telemetry || null,
        panelUrl: cell.panelUrl || '',
      });
    }
  };
  addCells(snapshot.cells, [...localSessions.values()], snapshot.localFresh === true);
  for (const group of snapshot.nodeGroups || []) {
    const route = Array.isArray(group.route) ? group.route : [];
    // Un device VL non e' una posizione fleet e non ospita celle: la route
    // che porta e' quella del suo OWNER, quindi coincide con la posizione
    // fleet di quell'owner. Discriminare sulla route vuota funzionava solo
    // finche' il nodo VL era locale; da un client federato la sua route non
    // e' vuota e le celle dell'owner verrebbero contate due volte, la
    // seconda sotto l'etichetta del device. Il criterio e' il tipo del
    // gruppo — lo stesso che usano Sidebar e SessionList.
    if (group.kind === 'vl' || !route.length) continue;
    addCells(group.cells, group.sessions, group.switcherFresh === true,
      route, group.label || group.name || '');
  }
  return rows;
}

// Il drawer visualizza soltanto celle Fleet, ma quando salva un riordino deve
// conoscere l'intero roster della posizione. In particolare, le tmux unmanaged
// restano nella lista principale e non devono mai sparire da nc_sidebar_order.
function rosterItemsByPosition(snapshot) {
  const positions = new Map();
  const localSessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const localCells = Array.isArray(snapshot.cells) ? snapshot.cells : [];
  const localByName = new Map(localSessions.map((entry) => [entry.name, entry]));
  const localCellSessions = new Set(localCells.map((cell) => cell.tmuxSession).filter(Boolean));
  positions.set('local', buildLocalRoster(
    localCells,
    localSessions.filter((entry) => !localCellSessions.has(entry.name)),
    localByName,
  ));
  for (const group of snapshot.nodeGroups || []) {
    const route = Array.isArray(group.route) ? group.route : [];
    // Stesso criterio di rowsFromSnapshot: un device VL condivide la route
    // del suo owner, e sovrascriverebbe il roster di quella posizione.
    if (group.kind === 'vl' || !route.length) continue;
    const cells = Array.isArray(group.cells) ? group.cells : [];
    const sessions = Array.isArray(group.sessions) ? group.sessions : [];
    const cellSessions = new Set(cells.map((cell) => cell.tmuxSession).filter(Boolean));
    positions.set(route.join('/'), buildRemoteRoster({
      ...group,
      route,
      cells,
      sessions,
      unmanaged: sessions.filter((entry) => !cellSessions.has(entry.name)),
    }).rawItems);
  }
  return positions;
}

// La rail resta una superficie compatta, ma mantiene le stesse sezioni logiche
// della lista principale: Locale prima, poi ciascuna route nell'ordine ricevuto.
// Entro una posizione applica esattamente nc_pins/nc_sidebar_order_v1.
function orderRowsByPosition(rows, rosterItems, pins, orders) {
  const positions = [...new Set(rows.map((row) => row.node || 'local'))];
  return positions.flatMap((position) => {
    const displayRows = rows.filter((row) => (row.node || 'local') === position);
    const canonical = new Map((rosterItems.get(position) || []).map((item) => [item.key, item]));
    const byKey = new Map(displayRows.map((row) => [row.key, row]));
    // Per il confronto usa gli stessi live/fresh/activity della home, ma
    // restituisce la riga del drawer per non alterarne stato e affordance.
    const sortable = displayRows.map((row) => {
      const item = canonical.get(row.key);
      return {
        ...row,
        label: item?.label || row.label,
        live: item?.live ?? row.live,
        fresh: item?.fresh === true,
        activity: item?.activity ?? row.activity,
      };
    });
    return sidebarItems(sortable, pins, 'all', sidebarOrder(orders, position))
      .map((item) => byKey.get(item.key));
  });
}

export default function CellSwitcher({ token, current, onPick, onClose, panelPort = 0, nodePanelPorts = {} }) {
  const [snapshot, setSnapshot] = useState(readCellSwitcherSnapshot);
  const [showAll, setShowAll] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  // La cella che si sta SBIRCIANDO. È distinta da quella selezionata: aprire
  // il popup non cambia dove sei — è la differenza fra guardare e andare.
  // Il popup tiene una CHIAVE, mai la riga: la lista si aggiorna sotto ogni
  // 4s e una riga salvata sarebbe un fotogramma morto — il popup che mostra
  // il contenuto della cella sbagliata (o quello stantio di una cella andata)
  // è esattamente il difetto che questo stato non deve permettere. A ogni
  // render la chiave si RIrisolve sulle righe correnti: o la cella c'è ancora
  // e il popup mostra il presente di QUELLA cella, o non c'è più e il popup
  // si chiude da sé. `source` è la sorgente aperta: anteprima, streaming o
  // pannello.
  const [peek, setPeek] = useState(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [picking, setPicking] = useState('');
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  // Ref del terminale nel popup: il contratto della tile, così Terminal non
  // dipende da chi lo monta. takeSize={false} sotto: il popup non ruba il
  // size-lock della sessione a chi sta sotto.
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const rows = useMemo(() => rowsFromSnapshot(snapshot), [snapshot]);
  const rosterItems = useMemo(() => rosterItemsByPosition(snapshot), [snapshot]);
  const { pins, orders, canMoveRoster, moveRoster, stepRoster } = useRosterPreferences();
  const orderedRows = useMemo(
    () => orderRowsByPosition(rows, rosterItems, pins, orders),
    [rows, rosterItems, pins, orders],
  );
  const visibleRows = useMemo(
    () => (showAll ? orderedRows : orderedRows.filter((row) => row.selectable || (row.degraded && row.active))),
    [orderedRows, showAll],
  );
  const selectedRow = useMemo(() => rows.find((row) => row.key === selectedKey && row.selectable), [rows, selectedKey]);
  // La riga sbirciata si RIrisolve a ogni lista: mai un fotogramma morto.
  const peekRow = useMemo(() => (peek ? rows.find((row) => row.key === peek.key) : null), [rows, peek]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const base = readCellSwitcherSnapshot();
      const groups = Array.isArray(base.nodeGroups) ? base.nodeGroups : [];
      const localRequest = readPosition(token);
      // Un device VL non e' una posizione fleet: la route che porta e' quella
      // del suo OWNER, quindi coincide con la posizione di quell'owner.
      // Interrogarlo farebbe rispondere l'owner, e il gruppo si riempirebbe
      // delle celle altrui. Deve restare FUORI dalla mappa per route: e'
      // chiavata sulla route e l'ultimo scrittore vince, quindi anche un
      // risultato vuoto qui cancellerebbe quello buono dell'owner.
      const isFleetPosition = (group) => group.kind !== 'vl'
        && Array.isArray(group.route) && group.route.length > 0;
      const remote = await Promise.all(groups.filter(isFleetPosition).map(async (group) => (
        { group, result: await readPosition(token, group.route) }
      )));
      const local = await localRequest;
      if (!alive) return;
      const byRoute = new Map(remote.map(({ group, result }) => [JSON.stringify(group.route || []), result]));
      const nodeGroups = groups.map((group) => {
        if (!isFleetPosition(group)) return { ...group, switcherFresh: false };
        const result = byRoute.get(JSON.stringify(group.route || []));
        if (!result) return { ...group, switcherFresh: false };
        return {
          ...group,
          sessions: result.sessions || group.sessions || [],
          cells: result.cells || group.cells || [],
          switcherFresh: result.fresh,
        };
      });
      const next = writeCellSwitcherSnapshot({
        ...base,
        sessions: local.sessions || base.sessions || [],
        cells: local.cells || base.cells || [],
        localFresh: local.fresh,
        nodeGroups,
        refreshedAt: Date.now(),
      });
      setSnapshot(next);
      setReady(true);
      inFlight = false;
    };
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  const statusFor = (row) => {
    if (row.degraded) return t('cell-degraded');
    if (!row.verified) return t('cell-switcher-not-confirmed');
    if (!row.selectable) return t('cell-off');
    return row.working ? t('cell-working') : t('cell-idle');
  };

  const select = (row) => {
    setNotice('');
    if (!row.selectable) {
      setNotice(t('cell-switcher-not-active'));
      return;
    }
    setSelectedKey(row.key);
  };

  const pick = async () => {
    const row = selectedRow;
    if (!row) {
      setNotice(t('cell-switcher-select'));
      return;
    }
    setNotice('');
    setPicking(row.key);
    try {
      // Una cella puo' morire tra il poll e il tocco: ricontrolla la posizione
      // prima di cambiare vista, cosi' non si tenta mai un attach stantio.
      const latest = await readPosition(token, row.route);
      const cell = (latest.cells || []).find((entry) => entry?.cell === row.cellName
        && entry?.tmuxSession === row.session);
      if (!isActiveCell(cell, latest.sessions, latest.fresh)) {
        setNotice(t('cell-switcher-not-active'));
        return;
      }
      onPick({ session: row.session, ...(row.node ? { node: row.node } : {}), cellName: row.cellName });
      onClose();
    } catch (_) {
      setNotice(t('cell-switcher-not-active'));
    } finally {
      setPicking('');
    }
  };

  return (
    <div className="nc-cell-switcher-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="nc-cell-switcher" role="dialog"
        aria-label={t('fleet-cells')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="nc-cell-switcher-list">
          {!ready && <div className="nc-empty" role="status">{t('cell-switcher-refreshing')}</div>}
          {ready && visibleRows.length === 0 && <div className="nc-empty" role="status">{t('cell-switcher-empty-active')}</div>}
          {visibleRows.map((row) => {
            const currentRow = current?.session === row.session && (current?.node || '') === row.node;
            const selected = selectedKey === row.key;
            const status = statusFor(row);
            // Vuota per le celle che non pubblicano telemetria: niente campo,
            // la riga resta esattamente com'era (il «dove supportato» richiesto).
            const attività = formattaAttività(t, row.activity);
            const telemetry = formattaTelemetria(t, row.telemetry);
            const rigaDati = [attività, telemetry].filter(Boolean).join(' · ');
            const position = row.node || 'local';
            const rawItems = rosterItems.get(position)
              || rows.filter((candidate) => (candidate.node || 'local') === position);
            return (
              <div key={row.key} className={`nc-cell-switcher-row${currentRow ? ' current' : ''}${selected ? ' selected' : ''}${row.selectable ? '' : ' off'}`}
                data-roster-key={row.key} data-position={position}>
                <RosterHandle position={position} itemKey={row.key} label={row.cellName}
                  canMove={canMoveRoster}
                  onMove={(source, target) => moveRoster(position, source, target, rawItems)}
                  onStep={(delta) => stepRoster(position, row.key, delta, rawItems)} />
                {/* Il pallino era uno span DENTRO il bottone di selezione: cliccarlo
                    cambiava cella. Ora è un bottone suo e apre il popup — guardare
                    una cella senza andarci, che è tutto il punto. Il resto della
                    riga continua a selezionare, invariato. Apre su ANTEPRIMA;
                    streaming e pannello si scelgono dentro, o dai bottoni stretti. */}
                <button type="button" className="nc-cell-switcher-peek"
                  title={t('cell-peek')} aria-label={`${t('cell-peek')}: ${row.cellName}`}
                  onClick={(event) => { event.stopPropagation(); setPeek({ key: row.key, source: 'preview' }); }}>
                  <span className={`nc-cell-switcher-dot${row.degraded ? ' warn' : row.live ? ` on${row.working ? ' working' : ''}` : ''}`} />
                </button>
                {/* Stretto (mobile): il puntino è un bersaglio troppo piccolo per
                    tre azioni — controlli veri e distinti, che aprono direttamente
                    la sorgente. `stopPropagation` anche qui: guardare non è
                    selezionare, su nessuno schermo. Sul largo restano nascosti e
                    il puntino resta il selettore. */}
                <span className="nc-cell-switcher-acts">
                  <button type="button" className="nc-cell-switcher-act"
                    title={t('cell-peek-stream')} aria-label={`${t('cell-peek-stream')}: ${row.cellName}`}
                    onClick={(event) => { event.stopPropagation(); setPeek({ key: row.key, source: 'stream' }); }}>▶</button>
                  {row.panelUrl && (
                    <button type="button" className="nc-cell-switcher-act"
                      title={t('cell-peek-panel')} aria-label={`${t('cell-peek-panel')}: ${row.cellName}`}
                      onClick={(event) => { event.stopPropagation(); setPeek({ key: row.key, source: 'panel' }); }}>▣</button>
                  )}
                </span>
                <button type="button" className="nc-cell-switcher-row-select"
                  aria-current={currentRow ? 'true' : undefined} aria-pressed={selected} aria-disabled={!row.selectable}
                  disabled={picking === row.key} onClick={() => select(row)}>
                  <span className="nc-cell-switcher-copy"><b>{row.cellName}</b><small className="nc-cell-switcher-state">{status}</small><small>{[row.nodeLabel, row.subtitle].filter(Boolean).join(' · ')}</small>{rigaDati && <small className="nc-cell-switcher-telemetry">{rigaDati}</small>}</span>
                </button>
              </div>
            );
          })}
        </div>
        {notice && <div className="nc-cell-switcher-notice" role="status">{notice}</div>}
        {/* `peek && peekRow`: se la lista aggiornata non ha più la cella, il
            popup si chiude da sé. Mostrare il contenuto di una riga morta —
            l'anteprima di un'ALTRA cella creduta la propria — è peggio di non
            vedere niente. La sorgente panel ricade su anteprima se la cella
            ha perso panelUrl: stesso principio, sul contratto della sorgente. */}
        {peek && peekRow && (() => {
          const source = peek.source === 'panel' && !peekRow.panelUrl ? 'preview' : peek.source;
          const tabs = [
            ['preview', t('cell-peek-preview')],
            ['stream', t('cell-peek-stream')],
            ...(peekRow.panelUrl ? [['panel', t('cell-peek-panel')]] : []),
          ];
          return (
            <CellPopup
              title={peekRow.cellName}
              subtitle={[peekRow.nodeLabel, peekRow.subtitle].filter(Boolean).join(' · ')}
              onClose={() => setPeek(null)}
            >
              {/* Le tre sorgenti in un contenitore solo: chi apre decide COSA
                  guardare, il contenitore decide COME si chiude. */}
              <div className="nc-peek-sorgenti" role="tablist">
                {tabs.map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={source === id}
                    className={`nc-peek-sorgente${source === id ? ' attiva' : ''}`}
                    onClick={() => setPeek({ key: peek.key, source: id })}>{label}</button>
                ))}
              </div>
              {source === 'stream' ? (
                <div className="nc-peek-stream">
                  <Terminal
                    key={`peek:${peekRow.key}`}
                    session={peekRow.session} node={peekRow.node || undefined} token={token}
                    readonly={false} takeSize={false} focused
                    sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
                    ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed}
                  />
                </div>
              ) : source === 'panel' ? (
                <CellPanel
                  cellId={peekRow.cellName}
                  panelUrl={peekRow.panelUrl}
                  route={peekRow.route || []}
                  panelPort={panelPortForRoute(peekRow.route || [], nodePanelPorts, panelPort)}
                  token={token}
                  title={peekRow.cellName}
                />
              ) : (
                <>
                  <pre className="nc-peek-testo">{peekRow.preview || t('cell-peek-vuoto')}</pre>
                  {formattaTelemetria(t, peekRow.telemetry) && (
                    <small className="nc-cell-switcher-telemetry">{formattaTelemetria(t, peekRow.telemetry)}</small>
                  )}
                </>
              )}
            </CellPopup>
          );
        })()}
        <div className="nc-cell-switcher-actions">
          <button type="button" className="nc-cell-switcher-open" disabled={!selectedRow || !!picking} onClick={pick}>
            {selectedRow ? `${t('cell-switcher-open')}: ${selectedRow.cellName}` : t('cell-switcher-select')}
          </button>
        </div>
        <div className="nc-cell-switcher-controls">
          <b>{t('fleet-cells')}</b>
          <button type="button" className="nc-cell-switcher-filter" aria-pressed={showAll}
            onClick={() => { setNotice(''); setShowAll((value) => !value); }}>
            {showAll ? t('cell-switcher-show-active') : t('cell-switcher-show-all')}
          </button>
          <button ref={closeRef} type="button" className="nc-cell-switcher-close" aria-label={t('cell-switcher-close')}
            title={t('cell-switcher-close')} onClick={onClose}>×</button>
        </div>
      </aside>
    </div>
  );
}
