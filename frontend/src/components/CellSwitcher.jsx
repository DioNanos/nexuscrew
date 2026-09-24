import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CellPeekBody, formattaAttività, formattaTelemetria } from './CellPeek.jsx';
import { apiFetch, clearHostCell, designateHostCell, fleetStatus, getLiveHost, getRouteSessions } from '../lib/api.js';
import { readCellSwitcherSnapshot, writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { buildLocalRoster, buildRemoteRoster, cellRuntime } from '../lib/roster-view-model.js';
import { positionKey } from '../lib/nodes-model.js';
import { sidebarItems, sidebarOrder } from '../lib/sidebar-model.js';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import { hostRouteKey } from '../lib/host-designation.js';
import { liveHostView } from '../lib/live-host-view.js';
import { runLiveHostCommand } from '../lib/live-host-command.js';
import RosterHandle from './RosterHandle.jsx';
import { CellActionsSheet, cellActionsItems, cellActionsState } from './CellActions.jsx';
import { applyCellStar, cellStarView } from '../lib/cell-star.js';
import { liveHostIndicatorKeys } from '../lib/live-host-view.js';
import { panelPortForRoute } from '../lib/panel-port.js';
import { readFontSize, writeFontSize } from '../lib/terminal-fontsize.js';
import { t } from '../lib/i18n.js';
import './CellSwitcher.css';

const POLL_MS = 4000;

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

export default function CellSwitcher({
  token, current, onPick, onClose, panelPort = 0, nodePanelPorts = {},
  // Il nome del nodo LOCALE (es. VPSCloud): il gruppo delle celle locali si
  // chiama come il nodo, come i gruppi remoti col loro nodeLabel.
  localNodeLabel = '',
  // Lo stato dell'host per nodo e le due azioni di designazione arrivano
  // dalle stesse callback che usa la home: la stella qui non ha una via sua.
  hostByRoute = {}, onDesignateCell, onClearHostCell, onLiveHostApplied,
  // L'intervallo del poll e' un parametro, non una costante letta dal modulo:
  // in produzione e' POLL_MS, nei test e' corto, cosi' nessun assert dipende da
  // un timer da 4 secondi che sotto carico puo' sforare il budget del waitFor.
  pollMs = POLL_MS,
}) {
  const [snapshot, setSnapshot] = useState(readCellSwitcherSnapshot);
  const [showAll, setShowAll] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  // La riga SELEZIONATA dal primo tocco: il gesto dell'operatore. Un tocco
  // seleziona e apre l'anteprima in alto; il secondo tocco sulla STESSA riga
  // apre. Come per il foglio azioni, lo stato tiene una CHIAVE, mai la riga:
  // la lista si aggiorna sotto ogni 4s e una riga salvata sarebbe un
  // fotogramma morto — l'anteprima del contenuto di una cella sbagliata (o
  // di una andata) è esattamente il difetto che questo stato non deve
  // permettere. A ogni render la chiave si RIrisolve sulle righe correnti:
  // o la cella c'è ancora e l'anteprima mostra il presente di QUELLA cella,
  // o non c'è più e la selezione si chiude da sé.
  const [selectedKey, setSelectedKey] = useState(null);
  // La sorgente dell'anteprima è CONTROLLATA, come vuole CellPeekBody: di
  // default il flusso, le altre due sorgenti sono le sue tab.
  // L'anteprima è NUDA: una sorgente sola, il flusso — niente tab né comando
  // Live (le azioni vivono nel foglio della riga), quindi non c'e' piu' uno
  // stato della sorgente da tenere.
  const ANTEPRIMA_SOURCE = 'stream';
  // Il font dell'anteprima è lo stesso del terminale principale: nc_fontsize.
  // I suoi − e + passano dallo stesso modulo, così il valore resta uno solo.
  const [fontSize, setFontSize] = useState(readFontSize);
  const zoom = (delta) => setFontSize((v) => writeFontSize(v + delta));
  // Il foglio azioni di una riga (⋯): contesto congelato all'apertura — la riga
  // che l'operatore ha toccato, non quella che il poll ha cambiato sotto le dita.
  const [menuRow, setMenuRow] = useState(null);
  // Riordino come MODALITA', con lo stesso pulsante della home mobile: le
  // maniglie compaiono solo quando la si accende, e senza modalita' la riga
  // resta un bersaglio d'apertura.
  const [reorderMode, setReorderMode] = useState(false);
  const [picking, setPicking] = useState('');
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const rows = useMemo(() => rowsFromSnapshot(snapshot), [snapshot]);
  const rosterItems = useMemo(() => rosterItemsByPosition(snapshot), [snapshot]);
  const {
    pins, orders, togglePin, removePin, pinError, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();
  const orderedRows = useMemo(
    () => orderRowsByPosition(rows, rosterItems, pins, orders),
    [rows, rosterItems, pins, orders],
  );
  const visibleRows = useMemo(
    () => (showAll ? orderedRows : orderedRows.filter((row) => row.selectable || (row.degraded && row.active))),
    [orderedRows, showAll],
  );
  // La riga selezionata si RIrisolve a ogni lista: mai un fotogramma morto.
  // E si ririsolve sulla lista VISTA e selezionabile: la riga che il filtro
  // attivo ha tolto, o la cella fermata, chiude l'anteprima come una riga
  // sparita — e la chiave si azzera con lei, così il ritorno della cella
  // ricomincia dal gesto (prima il tocco che seleziona, poi quello che apre)
  // invece di riaprirsi da solo su una selezione che non c'è più.
  const selectedRow = useMemo(
    () => (selectedKey ? visibleRows.find((row) => row.key === selectedKey && row.selectable) : null),
    [visibleRows, selectedKey],
  );
  useEffect(() => {
    if (selectedKey && !visibleRows.some((row) => row.key === selectedKey && row.selectable)) {
      setSelectedKey(null);
    }
  }, [visibleRows, selectedKey]);
  // La riga del foglio si ri-risolve allo stesso modo: se la cella non c'e' piu'
  // il foglio non si rende (e la sua chiave si azzera da sola, sotto).
  const menuResolved = useMemo(
    () => (menuRow ? rows.find((row) => row.key === menuRow.key) : null), [rows, menuRow],
  );
  const menuApertoFoglio = !!(menuRow && menuResolved);
  // Un pin che non si e' potuto scrivere non e' silenzioso nemmeno qui:
  // la home mostra un banner ritentabile, il selettore lo dice nella
  // propria riga di stato.
  useEffect(() => {
    if (pinError && pinError.message) setNotice(pinError.message);
  }, [pinError]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      // Con il foglio azioni aperto l'Escape chiude il FOGLIO, che ascolta sullo
      // stesso documento: senza questa guardia si chiuderebbero tutti e due, e
      // l'operatore perderebbe il selettore mentre sta scegliendo.
      if (event.key === 'Escape' && !menuApertoFoglio) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose, menuApertoFoglio]);

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
    const id = setInterval(refresh, pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [token, pollMs]);

  // Comando esplicito del Live host: una chiamata sola che legge la revisione
  // fresca e scrive (live-host-command.js). L'esito si vede SEMPRE nella riga di
  // stato, e `onLiveHostApplied` fa cambiare subito indicatore/puntino/stella
  // senza aspettare il poll.
  const [liveHostBusy, setLiveHostBusy] = useState('');
  const liveHostApi = {
    getLiveHost: (r) => getLiveHost(token, r),
    designateHostCell: (id, revision, r) => designateHostCell(token, id, revision, r),
    clearHostCell: (revision, r) => clearHostCell(token, revision, r),
  };
  const hostCellFor = (route) => (hostByRoute[hostRouteKey(route)] || {}).hostCell || null;
  const runHostCommand = async (row, isHost) => {
    setLiveHostBusy(row.key);
    const out = await runLiveHostCommand({
      action: isHost ? 'remove' : 'use', cellId: row.cellName, route: row.route || [], api: liveHostApi,
    });
    setLiveHostBusy('');
    setNotice(t(out.messageKey).replace('{cell}', out.hostCell || row.cellName));
    if (out.ok && onLiveHostApplied) {
      onLiveHostApplied({ route: row.route || [], hostCell: out.hostCell, revision: out.revision });
    }
  };

  const statusFor = (row) => {
    if (row.degraded) return t('cell-degraded');
    if (!row.verified) return t('cell-switcher-not-confirmed');
    if (!row.selectable) return t('cell-off');
    return row.working ? t('cell-working') : t('cell-idle');
  };

  // Il tocco della riga APRE la cella, e lo fa solo dopo il ricontrollo fresco:
  // una cella puo' morire tra il poll e il tocco, e un attach stantio non si
  // tenta mai. R27 #4: il ricontrollo ha TRE esiti, non due — «verificata
  // spenta» e' l'unico che puo' dirsi «non piu' attiva». Se la lettura non e'
  // riuscita (rete, timeout, 502: fresh false o eccezione) la cella NON e' stata
  // trovata spenta: dire il contrario faceva riavviare celle che stavano
  // lavorando (stessa famiglia di vl-events-stale e della tri-partizione in
  // fleet-read-policy.js). Una riga non selezionabile non si apre: lo dice e
  // basta, con la frase che la sua verifica autorizza.
  const open = async (row) => {
    setNotice('');
    if (!row.selectable) {
      setNotice(row.verified ? t('cell-switcher-not-active') : t('cell-switcher-not-confirmed'));
      return;
    }
    setPicking(row.key);
    try {
      const latest = await readPosition(token, row.route);
      const cell = (latest.cells || []).find((entry) => entry?.cell === row.cellName
        && entry?.tmuxSession === row.session);
      if (latest.fresh !== true) {
        setNotice(t('cell-switcher-verify-failed'));
        return;
      }
      if (!isActiveCell(cell, latest.sessions, latest.fresh)) {
        setNotice(t('cell-switcher-not-active'));
        return;
      }
      onPick({ session: row.session, ...(row.node ? { node: row.node } : {}), cellName: row.cellName });
      onClose();
    } catch (_) {
      setNotice(t('cell-switcher-verify-failed'));
    } finally {
      setPicking('');
    }
  };

  // Il GESTO della lista: un tocco seleziona la riga e apre l'anteprima in
  // alto; il secondo tocco sulla STESSA riga apre, col ricontrollo fresco che
  // c'e' gia' in open(). Un tocco su un'altra riga sposta lì la selezione.
  const tocca = (row) => {
    // Una riga non selezionabile non si sceglie: lo dice e basta, come prima.
    if (!row.selectable) { open(row); return; }
    if (selectedKey === row.key) { open(row); return; }
    setSelectedKey(row.key);
  };

  // Uno scroll NON e' un tocco: il dito che si muove per far scorrere la
  // lista non seleziona e non apre. Il gesto segue UN puntatore PRIMARIO per
  // id E per riga: un secondo dito mentre il gesto e' aperto, un cancel o uno
  // spostamento oltre la soglia lo invalidano — e lo spostamento conta nel
  // suo MASSIMO durante il gesto, anche se il dito torna al punto di
  // partenza. Invio e Spazio (click senza gesto di puntatore) sono
  // l'attivazione da tastiera: la stessa logica del tocco, e un gesto finito
  // male non la consuma. Un click di puntatore senza gesto registrato non
  // e' tastiera: non provato, non vale.
  const tapRef = useRef(null);
  const SOGLIA_TAP = 8;
  const toccoDown = (event) => {
    const cur = tapRef.current;
    // Un puntatore non primario non apre MAI un gesto: se il gesto e' aperto
    // lo invalida (due dita), se non c'e' non succede niente.
    if (event.isPrimary === false) {
      if (cur && cur.state === 'open') cur.state = 'invalid';
      return;
    }
    if (cur && cur.state === 'open' && (cur.id !== event.pointerId || cur.row !== event.currentTarget)) {
      cur.state = 'invalid'; // due dita, o un dito che cambia bersaglio
      return;
    }
    tapRef.current = {
      id: event.pointerId, row: event.currentTarget,
      x: event.clientX, y: event.clientY, maxDelta: 0, state: 'open',
    };
  };
  const toccoMove = (event) => {
    const cur = tapRef.current;
    if (!cur || cur.state !== 'open' || cur.id !== event.pointerId) return;
    cur.maxDelta = Math.max(cur.maxDelta, Math.hypot(event.clientX - cur.x, event.clientY - cur.y));
    if (cur.maxDelta > SOGLIA_TAP) cur.state = 'invalid';
  };
  const toccoUp = (event) => {
    const cur = tapRef.current;
    if (!cur || cur.id !== event.pointerId || cur.state !== 'open') return;
    cur.state = cur.maxDelta <= SOGLIA_TAP ? 'tap' : 'invalid';
  };
  const toccoCancel = (event) => {
    const cur = tapRef.current;
    if (cur && cur.id === event.pointerId) cur.state = 'invalid';
  };
  const toccoVale = (event) => {
    const cur = tapRef.current;
    tapRef.current = null; // il gesto, buono o cattivo, si consuma qui
    if (event.detail === 0) return true; // tastiera: Invio/Spazio, sempre valida
    if (!cur) return false; // click di puntatore senza gesto: non provato
    if (cur.state === 'invalid') return false; // due dita, cancel, o scroll
    // Il gesto appartiene alla riga dove e' nato: il click che lo conclude
    // arriva su quella riga, non su un'altra.
    if (cur.row !== event.currentTarget) return false;
    return Math.hypot(event.clientX - cur.x, event.clientY - cur.y) <= SOGLIA_TAP;
  };

  // Le azioni della riga, nel foglio (⋯): il pin e la Live. La logica resta
  // dov'e' gia' — pin via cell-star.js, Live via runLiveHostCommand, con la
  // stessa revisione letta-e-scritta e lo stesso esito nella riga di stato. Una
  // voce senza handler non compare: qui non si passa nessun gesto di boot, che
  // su questa superficie non esiste, e la voce non c'e'.
  const cellActionHandlers = (row) => ({
    onToggleLive: () => runHostCommand(row, hostCellFor(row.route || []) === row.cellName),
    onTogglePin: () => applyCellStar({
      view: cellStarView({
        item: { key: row.key, value: { cell: row.cellName } },
        pins, hostByRoute, route: row.route || [],
      }),
      itemKey: row.key, togglePin, removePin,
    }),
  });

  return (
    <div className="nc-cell-switcher-backdrop" onClick={onClose}>
      {/* L'anteprima della riga selezionata: la metà alta dello schermo, al
          posto del terminale oscurato. Sola lettura, stesso font del terminale
          principale. Il corpo è CellPeekBody — le tre sorgenti hanno un posto
          solo — qui aperto sul flusso. Il foglio lista resta sotto e scorre. */}
      {selectedRow && (
        <div className="nc-cell-switcher-anteprima" data-testid="cell-switcher-anteprima"
          onClick={(event) => event.stopPropagation()}>
          <div className="nc-cell-switcher-anteprima-testa">
            <b>{t('cell-switcher-preview-word')} {selectedRow.cellName}</b>
            <small>{t('cell-switcher-preview-readonly')}</small>
            <span className="nc-cell-switcher-anteprima-zoom">
              <button type="button" onClick={() => zoom(-1)} title={t('zoom-out')}
                aria-label={t('zoom-out')}>−</button>
              <span data-testid="cell-switcher-fontsize">{fontSize} px</span>
              <button type="button" onClick={() => zoom(+1)} title={t('zoom-in')}
                aria-label={t('zoom-in')}>+</button>
            </span>
          </div>
          <CellPeekBody
            row={selectedRow}
            token={token}
            source={ANTEPRIMA_SOURCE}
            chrome={false}
            panelPort={panelPortForRoute(selectedRow.route || [], nodePanelPorts, panelPort)}
            liveHost={liveHostView({ liveHost: hostByRoute[hostRouteKey(selectedRow.route || [])], cells: snapshot.cells || [] })}
            onLiveHostApplied={onLiveHostApplied}
            fontSize={fontSize}
            readOnly
          />
        </div>
      )}
      <aside ref={dialogRef} className={`nc-cell-switcher${selectedRow ? ' with-anteprima' : ''}`} role="dialog"
        aria-label={t('fleet-cells')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        {/* Intestazione compatta: «Celle» + il nome del nodo in piccolo, la
            pillola Attive|Tutte, il riordino e la chiusura come icone
            compatte — niente più titolo-lungo che tronca né quadratoni. */}
        <div className="nc-cell-switcher-controls">
          <b>{t('cell-switcher-title')}</b>
          {localNodeLabel && <small className="nc-cell-switcher-node">{localNodeLabel}</small>}
          <div className="nc-cell-switcher-filter" role="group" aria-label={t('cell-switcher-filter')}>
            <button type="button" className={!showAll ? 'on' : ''} aria-pressed={!showAll}
              onClick={() => { setNotice(''); setShowAll(false); }}>{t('cell-switcher-show-active')}</button>
            <button type="button" className={showAll ? 'on' : ''} aria-pressed={showAll}
              onClick={() => { setNotice(''); setShowAll(true); }}>{t('cell-switcher-show-all')}</button>
          </div>
          <button type="button" className={`nc-cell-switcher-reorder${reorderMode ? ' on' : ''}`}
            aria-pressed={reorderMode} title={t('reorder-help')} aria-label={t('reorder')}
            onClick={() => { setNotice(''); setReorderMode((value) => !value); }}>↕</button>
          <button ref={closeRef} type="button" className="nc-cell-switcher-close" aria-label={t('cell-switcher-close')}
            title={t('cell-switcher-close')} onClick={onClose}>×</button>
        </div>
        {/* Senza selezione, la riga che dice il gesto: si vede finché non c'e'
            un'anteprima aperta a dirlo da sola. Testo statico, non un annuncio
            di stato: il role="status" resta del notice, che è l'esito. */}
        {!selectedRow && (
          <div className="nc-cell-switcher-hint">{t('cell-switcher-tap-hint')}</div>
        )}
        <div className="nc-cell-switcher-list">
          {/* Live host di questo nodo: striscia compatta, dice chi e' l'host
              (e in che modalità) prima di scegliere una cella. Sola lettura:
              il comando Live sta nel foglio azioni della riga. Senza host
              designato non c'e' striscia — niente riga spesa. */}
          {(() => {
            const hostView = liveHostView({ liveHost: hostByRoute[hostRouteKey([])], cells: snapshot.cells || [] });
            if (!hostView || !hostView.cell) return null;
            const { modeKey } = liveHostIndicatorKeys(hostView);
            return (
              <div className="nc-cell-switcher-live-strip" data-testid="cell-switcher-live-strip">
                {t('cell-switcher-live-strip')
                  .replace('{cell}', hostView.cell)
                  .replace('{mode}', t(modeKey || 'live-host-mode-unknown'))}
              </div>
            );
          })()}
          {!ready && <div className="nc-empty" role="status">{t('cell-switcher-refreshing')}</div>}
          {ready && visibleRows.length === 0 && <div className="nc-empty" role="status">{t('cell-switcher-empty-active')}</div>}
          {visibleRows.map((row, indice) => {
            const currentRow = current?.session === row.session && (current?.node || '') === row.node;
            const menuAperto = !!menuRow && menuRow.key === row.key;
            const status = statusFor(row);
            // Vuota per le celle che non pubblicano telemetria: niente campo,
            // la riga resta esattamente com'era (il «dove supportato» richiesto).
            const attività = formattaAttività(t, row.activity);
            const telemetry = formattaTelemetria(t, row.telemetry);
            const rigaDati = [attività, telemetry].filter(Boolean).join(' · ');
            const position = row.node || 'local';
            // l'etichetta del nodo sale UNA volta, in testa al suo
            // gruppo, invece di ripetersi su ogni riga.
            const precedente = indice > 0 ? (visibleRows[indice - 1].node || 'local') : null;
            const apreGruppo = position !== precedente;
            const rawItems = rosterItems.get(position)
              || rows.filter((candidate) => (candidate.node || 'local') === position);
            return (
              <Fragment key={row.key}>
              {apreGruppo && (
                <div className="nc-cell-switcher-position">
                  {t('cell-switcher-group').replace('{node}',
                    row.nodeLabel || localNodeLabel || t('cell-switcher-group-local'))}
                </div>
              )}
              <div className={`nc-cell-switcher-row${currentRow ? ' current' : ''}${selectedKey === row.key ? ' selected' : ''}${row.selectable ? '' : ' off'}`}
                data-roster-key={row.key} data-position={position}>
                {/* Riordino a MODALITA', come nella home mobile: senza modalita'
                    la maniglia non esiste nel DOM, e la riga e' solo un bersaglio. */}
                {reorderMode && <RosterHandle position={position} itemKey={row.key} label={row.cellName}
                  canMove={canMoveRoster}
                  onMove={(source, target) => moveRoster(position, source, target, rawItems)}
                  onStep={(delta) => stepRoster(position, row.key, delta, rawItems)} />}
                {/* Il pallino (44 px) mostra lo STATO e nient'altro: guardare
                    dal vivo adesso e' il primo tocco della riga, che apre
                    l'anteprima in alto in sola lettura. Il gesto e' sulla
                    riga intera, un solo bersaglio. */}
                <span className="nc-cell-switcher-peek">
                  <span className={`nc-cell-switcher-dot${row.degraded ? ' warn' : row.live ? ` on${row.working ? ' working' : ''}` : ''}`} />
                </span>
                {/* Il tocco della riga SELEZIONA e apre l'anteprima; il secondo
                    tocco sulla stessa riga APRE, e il ricontrollo fresco lo
                    precede sempre: una cella puo' morire tra il poll e il dito.
                    Uno scroll non conta: il tocco vale solo senza movimento. */}
                <button type="button" className="nc-cell-switcher-row-select"
                  aria-current={currentRow ? 'true' : undefined} aria-disabled={!row.selectable}
                  data-selected={selectedKey === row.key ? 'true' : undefined}
                  disabled={picking === row.key}
                  onPointerDown={toccoDown} onPointerMove={toccoMove}
                  onPointerUp={toccoUp} onPointerCancel={toccoCancel}
                  onClick={(event) => { if (!toccoVale(event)) return; tocca(row); }}>
                  <span className="nc-cell-switcher-copy">
                    <span className="nc-cell-switcher-nameline">
                      <b>{row.cellName}</b>
                      {currentRow && <span className="nc-cell-switcher-here">{t('cell-switcher-here')}</span>}
                      {selectedKey === row.key && <span className="nc-cell-switcher-taptwo">{t('cell-switcher-two-taps')}</span>}
                    </span>
                    {/* UNA riga di stato: la parola (una sola fonte, il poll
                        che ha confermato la cella) e il tempo dall'ultima
                        attivita'. La telemetria, se c'e', entra QUI con
                        l'ellissi: non aggiunge una terza riga. Il vecchio
                        sottotitolo dell'hook non e' piu' una seconda
                        rappresentazione dello stesso fatto. */}
                    <span className="nc-cell-switcher-stateline">
                      <small className="nc-cell-switcher-state">{status}</small>
                      {rigaDati && <small className="nc-cell-switcher-telemetry">{rigaDati}</small>}
                    </span>
                  </span>
                </button>
                {/* Le azioni della riga in un foglio dal basso: il pin e la Live.
                    Non stanno piu' in fila come stella e comando: la riga resta
                    pallino + testo + ⋯, come il disegno approvato. */}
                <button type="button" className={`nc-cell-switcher-menu${menuAperto ? ' on' : ''}`}
                  title={`${t('cell-actions-open')}: ${row.cellName}`}
                  aria-label={`${t('cell-actions-open')}: ${row.cellName}`}
                  aria-haspopup="menu" aria-expanded={menuAperto ? 'true' : 'false'}
                  onClick={(event) => { event.stopPropagation(); setMenuRow({ key: row.key }); }}>⋯</button>
              </div>
              </Fragment>
            );
          })}
        </div>
        {notice && <div className="nc-cell-switcher-notice" role="status">{notice}</div>}
        {/* Le azioni della riga, dal basso. Il contenuto e' di CellActions
            (fase 1): qui si passano solo gli handler, e una voce senza handler
            non compare — e' il suo contratto. Se la cella e' sparita dalla
            lista aggiornata il foglio si chiude da se', come il popup. */}
        {menuApertoFoglio && (() => {
          const row = menuResolved;
          const items = cellActionsItems({
            ...cellActionsState({
              item: { key: row.key, value: { cell: row.cellName } },
              cellName: row.cellName, route: row.route || [], pins, hostByRoute,
            }),
            canBoot: false,
            alive: row.selectable,
            handlers: cellActionHandlers(row),
          });
          return <CellActionsSheet cellName={row.cellName} items={items}
            busy={liveHostBusy === row.key} onClose={() => setMenuRow(null)} />;
        })()}
      </aside>
    </div>
  );
}
