import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch, fleetStatus, fleetBoot, killSession, nodeAction, renameNodeLabel, setSessionTechnical,
} from '../lib/api.js';
import Icon from './Icon.jsx';
import CellPeek from './CellPeek.jsx';
import { panelPortForRoute } from '../lib/panel-port.js';
import { sidebarItems, sidebarOrder, sidebarSearchVisible } from '../lib/sidebar-model.js';
import PowerSheet from './PowerSheet.jsx';
import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useNodes } from '../hooks/useNodes.js';
import RosterHandle from './RosterHandle.jsx';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import { useNodePreferences } from '../hooks/useNodePreferences.js';
import {
  hostRenderState, hostLeaseTitleKey, hostThreadTitleKey, hostRouteKey,
} from '../lib/host-designation.js';
import PinPersistBanner from './PinPersistBanner.jsx';
import { CellActionsSheet, cellActionsItems, cellActionsState } from './CellActions.jsx';
import { applyCellStar, cellStarView } from '../lib/cell-star.js';
import { runLiveHostCommand } from '../lib/live-host-command.js';
import { liveHostView, liveHostDotClass } from '../lib/live-host-view.js';
import {
  rel, nodeStateLabel, healthDot, healthTitle, buildLocalRoster, buildRemoteRoster,
} from '../lib/roster-view-model.js';
import { OWNER_ID_RE } from '../lib/grid-model.js';
import { isValidLabel } from '../lib/settings-model.js';
import { runFleetPowerAction } from '../lib/fleet-action-notice.js';
import useActionNotice from '../hooks/useActionNotice.js';
import { fleetReadOutcome } from '../lib/fleet-read-policy.js';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import './SessionList.css';

const bootCellKey = (cell, route = []) => `${route.length ? route.join('/') : 'local'}:${cell}`;

// Home mobile: lo stesso roster per-posizione della sidebar desktop. Stato di
// apertura, filtro, pin e ordine hanno quindi un solo contratto condiviso
// (hook useRosterPreferences + model roster-view-model).

export default function SessionList({
  onPick, token, onSettings, onOpenVlSession, hostByRoute = {}, onDesignateCell, onClearHostCell,
  panelPort = 0, nodePanelPorts = null,
}) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  // Gruppi per-nodo remoto (B2): zero nodi configurati -> [] e home identica.
  const nodeGroups = useNodes(token);
  const [sessions, setSessions] = useState(null); // null = primo load
  const [err, setErr] = useState(null);
  // La lettura LOCALE delle sessioni e' riuscita? Una caduta non e' «zero
  // sessioni»: e' un dato non verificato, e il roster deve dirlo.
  const [localReadOk, setLocalReadOk] = useState(true);
  const [q, setQ] = useState('');
  const [version, setVersion] = useState('');
  const [endpoint, setEndpoint] = useState({ bind: '127.0.0.1', port: '' });
  const [localNodeId, setLocalNodeId] = useState('');
  const [cells, setCells] = useState([]);
  const [fleetCapabilities, setFleetCapabilities] = useState([]);
  // R27: la lettura del fleet non e' riuscita (rete/401/5xx o fleet.json
  // illeggibile) → la lista esposta e' l'ultima nota, non un dato: lo si dichiara.
  const [fleetStale, setFleetStale] = useState(false);
  // R27 rev3: il fleet e' SPENTO (available:false del server) → zero celle e'
  // la verita'; l'indicatore distinto porta il reason del server.
  const [fleetOff, setFleetOff] = useState(null);
  const [bootOverrides, setBootOverrides] = useState({});
  const [bootBusy, setBootBusy] = useState(new Set());
  const [powerCell, setPowerCell] = useState(null);
  // Notice d'azione del roster: superficie propria con auto-clear, NON l'errore
  // di lettura che il refresh azzera a ogni ciclo riuscito.
  const { notice: actionNotice, showActionNotice } = useActionNotice();
  const [nodeBusy, setNodeBusy] = useState(null);
  // Menu azioni cella (⋯): contesto CONGELATO all'apertura. Il foglio mostra la
  // cella che l'operatore ha toccato, non una riga che nel frattempo il poll ha
  // cambiato sotto le dita.
  const [menuCell, setMenuCell] = useState(null);
  const [menuBusy, setMenuBusy] = useState(false);
  // Esito dell'ultimo comando Live: vive nella striscia, dove l'occhio guarda.
  const [liveNotice, setLiveNotice] = useState(null);
  // «Guarda dal vivo» (dal foglio): la finestra di anteprima di una cella, la
  // STESSA CellPeek che aprono sidebar e selettore — qui si sceglie la cella e
  // si entra direttamente dalla sorgente Flusso, che su telefono è l'unica
  // sorgente vera (la nuvola al passaggio non esiste senza puntatore).
  const [peekKey, setPeekKey] = useState(null);
  const [peekSource, setPeekSource] = useState('preview');
  // Riordino come MODALITA': le maniglie compaiono solo quando la si accende
  // dall'intestazione. Senza, la riga è un bersaglio d'apertura e basta.
  const [reorderMode, setReorderMode] = useState(false);
  const {
    pins, orders, togglePin, removePin, pinError, retryPinPersist, clearPinError, viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();
  // Stato live del NODO che possiede `route` — mai quello di un altro nodo.
  const hostFor = (route) => hostByRoute[hostRouteKey(route)] || {};
  // Il ciclo della stellina vive in CellStar/applyCellStar: stessa
  // implementazione per la home, la sidebar e il selettore compatto.
  const {
    groupsFor: preferredGroups, moveNode, stepNode, nodeKey,
  } = useNodePreferences();
  const preferredNodeGroups = preferredGroups(nodeGroups);
  // La vista singola mobile smonta questa lista: conserva solo l'ultimo
  // snapshot già disponibile per l'apertura immediata del CellSwitcher.
  useEffect(() => {
    writeCellSwitcherSnapshot({ sessions: sessions || [], cells, nodeGroups, localNodeId });
  }, [sessions, cells, nodeGroups, localNodeId]);

  // Converge l'override ottimistico sulla source of truth restituita dai poll
  // locali/Hydra. PowerSheet e toggle diretto scrivono la stessa proprieta'.
  useEffect(() => {
    const actual = new Map();
    for (const c of cells) actual.set(bootCellKey(c.cell), !!c.boot);
    for (const g of nodeGroups) {
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

  async function refresh() {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (j.error) { setErr(j.error); setSessions([]); setLocalReadOk(false); }
      else { setErr(null); setSessions(j.sessions || []); setLocalReadOk(true); }
    } catch (e) { setErr(String(e)); setSessions([]); setLocalReadOk(false); }
    // flotta nello stesso interval del polling sessioni (4s). R27: la
    // decisione e' la policy pura condivisa col desktop — un fallimento di
    // lettura NON svuota la lista (non e' «zero celle»), resta l'ultima nota
    // con l'indicatore stale. Mai presentare una lista vuota come un dato.
    let fs = null; let fleetError = null;
    try { fs = await fleetStatus(token); } catch (e) { fleetError = e; }
    const fleet = fleetReadOutcome({ fs, error: fleetError });
    if (fleet.kind === 'data') {
      setCells(fleet.cells);
      setFleetCapabilities(fleet.capabilities);
      setFleetStale(false);
      setFleetOff(null);
    } else if (fleet.kind === 'stale') {
      setFleetStale(true);
      setFleetOff(null);
    } else {
      // spento per scelta (o non classificato): zero celle e' la verita' del
      // server — lista vuota con indicatore, mai l'ultima lista come fantasma
      setCells([]);
      setFleetCapabilities([]);
      setFleetStale(false);
      setFleetOff(fleet.reason || '');
    }
  }

  useEffect(() => {
    refresh();
    apiFetch('/api/config', token).then((r) => r.json())
      .then((j) => {
        setVersion(j.version || '');
        setEndpoint({ bind: j.bind || '127.0.0.1', port: j.port || '' });
        setLocalNodeId(OWNER_ID_RE.test(String(j.instanceId || '')) ? j.instanceId : '');
      }).catch(() => {});
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  async function copyEndpointUrl() {
    if (!endpoint.port) return;
    const url = `http://${endpoint.bind}:${endpoint.port}/#token=${token}`;
    try { await navigator.clipboard.writeText(url); } catch (_) { /* clipboard non disponibile */ }
  }

  function setBootChoice(cell, route, enabled) {
    const key = bootCellKey(cell, route);
    setBootOverrides((current) => ({ ...current, [key]: !!enabled }));
  }

  function bootEnabled(c, route = []) {
    const key = bootCellKey(c.cell, route);
    return Object.prototype.hasOwnProperty.call(bootOverrides, key) ? bootOverrides[key] : !!c.boot;
  }

  async function onBootToggle(event, c, route = [], nextForzato) {
    if (event) event.stopPropagation();
    const key = bootCellKey(c.cell, route);
    const enabled = typeof nextForzato === 'boolean' ? nextForzato : !bootEnabled(c, route);
    setBootChoice(c.cell, route, enabled);
    setBootBusy((current) => new Set(current).add(key));
    try {
      // Cambia soltanto la preferenza per il prossimo boot: lifecycle invariato.
      await fleetBoot(token, { cell: c.cell, enabled }, route);
      if (!route.length) setCells((current) => current.map((entry) => (
        entry.cell === c.cell ? { ...entry, boot: enabled } : entry
      )));
    } catch (error) {
      setBootOverrides((current) => { const next = { ...current }; delete next[key]; return next; });
      setErr(String(error?.message || error));
    } finally {
      setBootBusy((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }

  // I gesti del menu azioni (⋯) di una cella: la LOGICA resta dov'è già — pin
  // via cell-star.js, Live via runLiveHostCommand (l'esito arriva nella
  // striscia), boot via la STESSA onBootToggle del power, quindi stesso
  // override ottimistico e stesso rollback. Qui non si duplica niente.
  //
  // «Guarda dal vivo» apre la finestra di anteprima — la STESSA CellPeek di
  // sidebar e selettore, col suo guscio CellPopup che sullo stretto diventa
  // foglio — entrando direttamente dalla sorgente Flusso: su telefono la nuvola
  // al passaggio non esiste, e senza questa voce la Live di una cella non
  // sarebbe raggiungibile. La voce compare solo su una cella VIVA (`alive`):
  // su una spenta non si passa onWatchLive e la voce non c'è.
  const cellActionHandlers = (item, c, route) => ({
    onToggleLive: async () => {
      const stato = cellActionsState({ item, cellName: c.cell, route, pins, hostByRoute });
      setMenuBusy(true);
      const out = await runLiveHostCommand({
        action: stato.isLive ? 'remove' : 'use', cellId: c.cell, route, token,
      });
      setMenuBusy(false);
      setLiveNotice({ messageKey: out.messageKey, ok: out.ok, cell: out.hostCell || c.cell });
    },
    onTogglePin: () => applyCellStar({
      view: cellStarView({ item, pins, hostByRoute, route }),
      itemKey: item.key, togglePin, removePin,
    }),
    onToggleBoot: (next) => onBootToggle(null, c, route, next),
    onWatchLive: () => {
      setPeekSource('stream');
      setPeekKey(item.key);
    },
  });

  async function onFleetConfirm(payload) {
    if (!powerCell) return;
    // Esiti benigni (timeout client, sessione già attiva) chiudono il foglio
    // con una notice sul roster; gli errori veri restano nel foglio. Se il
    // foglio è già stato chiuso con cancel, ogni esito — buono o cattivo —
    // arriva comunque come notice: l'azione continua in background.
    let benign = null;
    try {
      benign = await runFleetPowerAction({ token, powerCell, payload, onNotice: showActionNotice });
    } catch (e) {
      showActionNotice(String((e && e.message) || e));
      throw e;
    }
    if (!benign) {
      const { cell } = powerCell;
      const route = Array.isArray(powerCell.route) ? powerCell.route : [];
      if (payload.action === 'up') setBootChoice(cell, route, !!payload.boot);
      else if (payload.boot) setBootChoice(cell, route, false);
    }
    refresh();
  }

  // Stato fresco per il foglio di alimentazione: la copia presa all'apertura
  // può restare indietro rispetto all'inventario (cella che parte mentre il
  // foglio è aperto). Lo stato arriva dall'inventario corrente, per id,
  // locale e remoto.
  const powerCellLive = useMemo(() => {
    if (!powerCell) return null;
    const rk = (Array.isArray(powerCell.route) ? powerCell.route : []).join('/');
    const pool = [
      ...cells,
      ...nodeGroups.flatMap((g) => (g.cells || []).map((c) => ({ ...c, route: g.route || [g.name] }))),
    ];
    const live = pool.find((c) => c.cell === powerCell.cell
      && (Array.isArray(c.route) ? c.route.join('/') : '') === rk);
    return live ? { ...powerCell, active: !!live.active } : powerCell;
  }, [powerCell, cells, nodeGroups]);

  async function onKill(name, route = []) {
    try { await killSession(token, name, route); } catch (_) { return; }
    refresh();
  }

  async function onTechnical(name, technical, route = []) {
    try { await setSessionTechnical(token, name, technical, route); } catch (_) { return; }
    refresh();
  }

  async function onNodePower(group) {
    if (!group?.direct || nodeBusy) return;
    setNodeBusy(group.name);
    try { await nodeAction(token, group.name, group.tunnelStatus === 'up' ? 'down' : 'up'); }
    catch (_) {}
    setNodeBusy(null);
  }

  async function promptNodeRename(group) {
    if (!group?.direct) return;
    const next = window.prompt(t('rename-node-prompt'), group.label || group.name);
    if (next === null) return;
    const label = String(next).trim();
    if (!isValidLabel(label)) { window.alert(t('rename-node-invalid')); return; }
    try { await renameNodeLabel(token, group.name, label); }
    catch (error) { window.alert(String(error?.message || error)); }
  }

  // lookup sessione per tmuxSession (activity/preview/outbox delle celle)
  const byName = useMemo(() => new Map((sessions || []).map((s) => [s.name, s])), [sessions]);
  const cellSessions = useMemo(() => new Set(cells.map((c) => c.tmuxSession)), [cells]);
  const unmanaged = useMemo(
    () => (sessions || []).filter((s) => !cellSessions.has(s.name)),
    [sessions, cellSessions],
  );
  const localRawItems = useMemo(
    () => buildLocalRoster(cells, unmanaged, byName, undefined, { autorevole: localReadOk }),
    [cells, unmanaged, byName],
  );

  // Le righe-cella di TUTTE le posizioni, per chiave: serve a RI-RISOLVERE la
  // cella della sbirciata a ogni render (mai un oggetto riga congelato) e a
  // prenderne le sessioni DALLA SUA route. Un tmuxSession non è unico nella
  // federazione: per una cella remota la tabella locale risponderebbe con
  // l'omonima, e la finestra mostrerebbe l'anteprima di un'ALTRA cella creduta
  // la propria. Route vuota = locale, ed è già il criterio con cui il roster
  // decide dove guardare.
  const cellItemsByKey = useMemo(() => {
    const map = new Map();
    for (const item of localRawItems) {
      if (item.type === 'cell') {
        map.set(item.key, { item, route: [], nodeLabel: '', sessions: sessions || [], cells });
      }
    }
    for (const g of preferredNodeGroups) {
      const route = Array.isArray(g.route) ? g.route : [];
      // Stesso criterio di rowsFromSnapshot e della sidebar: un device VL non
      // è una posizione fleet e le sue celle appartengono all'owner.
      if (!route.length || g.kind === 'vl') continue;
      const { rawItems } = buildRemoteRoster(g);
      for (const item of rawItems) {
        if (item.type === 'cell') {
          map.set(item.key, {
            item, route, nodeLabel: g.label || g.name || '',
            sessions: g.sessions || [], cells: g.cells || [],
          });
        }
      }
    }
    return map;
  }, [localRawItems, preferredNodeGroups, sessions, cells]);

  const peekRow = useMemo(() => {
    if (!peekKey) return null;
    const trovata = cellItemsByKey.get(peekKey);
    // Cella sparita dalla lista aggiornata: nessun popup, come in R4.
    if (!trovata) return null;
    const c = trovata.item.value;
    const s = (trovata.sessions || []).find((entry) => entry.name === c.tmuxSession) || {};
    return {
      row: {
        key: trovata.item.key,
        cellName: c.cell,
        subtitle: trovata.item.subtitle || '',
        nodeLabel: trovata.nodeLabel,
        node: trovata.route.length ? trovata.route.join('/') : '',
        session: c.tmuxSession,
        route: trovata.route,
        panelUrl: c.panelUrl || '',
        telemetry: s.telemetry || null,
        preview: s.preview || c.preview || '',
        activity: s.activity || c.activity || 0,
      },
      cells: trovata.cells || [],
    };
  }, [peekKey, cellItemsByKey]);

  const localView = viewFor('local');
  const localItems = useMemo(
    () => sidebarItems(localRawItems, pins, localView.filter, sidebarOrder(orders, 'local'))
      .filter((item) => sidebarSearchVisible(item, q)),
    [localRawItems, pins, localView.filter, q, orders],
  );
  const remoteCount = preferredNodeGroups.reduce(
    (sum, g) => sum + (g.cells || []).length + (g.unmanaged || []).filter((s) => !s.technical).length, 0,
  );
  const rosterTotal = sidebarItems(localRawItems, pins, 'all', sidebarOrder(orders, 'local')).length + remoteCount;

  // Il vecchio header contava solo /api/sessions locale: con celle Fleet vive
  // ricavate dall'inventario (o route Hydra) poteva quindi mostrare 0. Conta
  // l'unione normalizzata celle-live + tmux unmanaged, senza duplicare la
  // sessione sottostante di una cella.
  const total = localRawItems.filter((item) => item.live).length
    + preferredNodeGroups.reduce((sum, group) => (
      sum + buildRemoteRoster(group).rawItems.filter((item) => item.live).length
    ), 0);
  const attachedRaw = (sessions || []).filter((s) => s.attached).length
    + preferredNodeGroups.reduce(
      (sum, group) => sum + (group.sessions || []).filter((s) => s.attached).length, 0,
    );
  // Durante la cache status una sessione tmux puo' risultare ancora attached
  // mentre la cella Fleet e' gia' off. Il sottoconteggio non deve mai superare
  // l'inventario live normalizzato mostrato nello stesso header.
  const attached = Math.min(attachedRaw, total);
  const endpointLabel = endpoint.port ? `${endpoint.bind}:${endpoint.port}` : endpoint.bind;

  function renderRosterItem(item, group = null, rawItems = localRawItems) {
    const route = Array.isArray(group?.route) ? group.route : [];
    const routeKey = route.join('/'); const position = routeKey || 'local';
    const ownerId = route.length ? group?.instanceId : localNodeId;
    const pickOwned = (name, cellName) => onPick({
      session: name,
      ...(routeKey ? { node: routeKey } : {}),
      ...(OWNER_ID_RE.test(String(ownerId || '')) ? { ownerId } : {}),
      ...(typeof cellName === 'string' && cellName ? { cellName } : {}),
    });
    const canMove = canMoveRoster;
    if (item.type === 'cell') {
      const c = item.value;
      const host = hostFor(route);
      const starState = hostRenderState({ hostCell: host.hostCell ?? null, threadStatus: host.threadStatus, pins, item });
      const session = route.length
        ? (group?.sessions || []).find((candidate) => candidate.name === c.tmuxSession)
        : byName.get(c.tmuxSession);
      // Come in Sidebar: sull'host designato il titolo porta anche lo stato del
      // lease — quello DEL NODO GIUSTO (hostFor(route)), locale o remoto.
      const leaseKey = hostLeaseTitleKey(starState, host.hostLease ?? null);
      const baseStateTitle = c.degraded
        ? t('cell-degraded')
        : item.subtitle || (c.tmux ? t('cell-idle') : t('cell-off'));
      const stateTitle = leaseKey ? `${baseStateTitle} · ${t(leaseKey)}` : baseStateTitle;
      const canPower = route.length === 0 || (group?.capabilities || []).includes(c.active ? 'down' : 'up');
      const canBoot = route.length === 0
        ? fleetCapabilities.includes('boot')
        : (group?.capabilities || []).includes('boot');
      const boot = bootEnabled(c, route);
      // Lo stato delle azioni della cella, una volta sola: il bollino LIVE della
      // riga e il foglio (all'apertura) leggono la stessa derivazione pura.
      const azioni = cellActionsState({ item, cellName: c.cell, route, pins, hostByRoute });
      const menuAperto = !!menuCell && menuCell.itemKey === item.key;
      const menuLabel = `${t('cell-actions-open')}: ${c.cell}`;
      return (
        <div key={item.key} className="nc-mcard" data-roster-key={item.key} data-position={position}>
          {reorderMode && <RosterHandle position={position} itemKey={item.key} label={c.cell}
            canMove={canMove}
            onMove={(source, target) => moveRoster(position, source, target, rawItems)}
            onStep={(delta) => stepRoster(position, item.key, delta, rawItems)} />}
          <button className="nc-mcard-main"
            onClick={() => c.tmux && pickOwned(c.tmuxSession, c.cell)}
            title={stateTitle} aria-label={`${c.cell}, ${stateTitle}`}>
            <span className={`dot ${c.degraded ? 'warn' : c.tmux ? `on${item.working ? ' working' : ''}` : ''}`} />
            <span className="nc-mcard-text">
              {/* Il bollino è un FRATELLO del nome, non un suo figlio: il nome
                  resta il testo esatto della cella per chi legge e per i test. */}
              <span className="nc-mcard-nome">
                <b>{c.cell}</b>
                {azioni.isLive && <span className="nc-m-live">LIVE</span>}
              </span>
              <small title={item.subtitle}>{item.subtitle}</small>
            </span>
          </button>
          {item.activity ? <span className="nc-rel">{rel(item.activity)}</span> : null}
          {item.fresh && session?.outbox?.count > 0 && <span className="nc-badge" title={t('new-files-outbox')}>{session.outbox.count}</span>}
          {/* Le azioni della cella: ⋯ e power, 44 px ciascuno. Pin e avvio al
              boot NON stanno nella riga — vivono nel foglio, che è l'unico
              posto dove si vedono anche il loro stato e le voci che in fila non
              ci starebbero (la Live). La riga resta un bersaglio d'apertura,
              con due comandi diretti: le azioni e l'alimentazione. */}
          <button type="button" className={`nc-act cellmenu${menuAperto ? ' on' : ''}`}
            title={menuLabel} aria-label={menuLabel}
            aria-haspopup="menu" aria-expanded={menuAperto ? 'true' : 'false'}
            onClick={() => setMenuCell({ itemKey: item.key, item, cell: c, route, canBoot })}>⋯</button>
          {canPower && <button className={`nc-act power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
            onClick={() => setPowerCell(route.length
              ? { ...c, boot, route, availableEngines: group?.engines || [] }
              : { ...c, boot })}
            title={c.active ? t('power-off') : t('power-on')} aria-label={`${c.active ? t('power-off') : t('power-on')} ${c.cell}`}>
            <Icon name="power" size={16} />
          </button>}
        </div>
      );
    }

    const s = item.value;
    return (
      <div key={item.key} className="nc-mcard" data-roster-key={item.key} data-position={position}>
        <RosterHandle position={position} itemKey={item.key} label={s.name}
          canMove={canMove}
          onMove={(source, target) => moveRoster(position, source, target, rawItems)}
          onStep={(delta) => stepRoster(position, item.key, delta, rawItems)} />
        <button className="nc-mcard-main" onClick={() => pickOwned(s.name)}>
          <span className={s.attached ? 'dot on' : 'dot'} />
          <span className="nc-mcard-text">
            <b>{s.name}</b>
            <small>{s.preview ? s.preview : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}</small>
          </span>
        </button>
        {item.activity ? <span className="nc-rel">{rel(item.activity)}</span> : null}
        {item.fresh && s.outbox?.count > 0 && <span className="nc-badge" title={t('new-files-outbox')}>{s.outbox.count}</span>}
        <button className={`nc-act pin${pins.includes(item.key) ? ' on' : ''}`}
          aria-label={`${t('pin')} ${s.name}`} title={t('pin')} onClick={() => togglePin(item.key)}>
          {pins.includes(item.key) ? '\u2605' : '\u2606'}
        </button>
        <button className={`nc-act technical${s.technical ? ' on' : ''}`}
          title={s.technical ? t('mark-normal') : t('mark-technical')}
          aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
          onClick={() => onTechnical(s.name, !s.technical, route)}>T</button>
        <button className="nc-menu" title={t('terminate')} aria-label={`${t('terminate')} ${s.name}`}
          onClick={() => { if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill(s.name, route); }}>⋯</button>
      </div>
    );
  }

  return (
    <div className="nc-home">
      <header className="nc-home-head">
        <div className="nc-wordmark">NexusCrew<span className="nc-cursor" /></div>
        <div className="nc-home-sub">
          {t('fleet-tmux')} · {total} {t('sessions')}{attached > 0 && ` · ${attached} attached`}
        </div>
        <span className="nc-head-actions">
          {/* Il riordino è una MODALITA', non un gesto sempre armato: la si
              accende qui e le maniglie compaiono sulle righe. Spenta, la riga
              è solo un bersaglio d'apertura. */}
          <button className={`nc-refresh${reorderMode ? ' on' : ''}`} onClick={() => setReorderMode((v) => !v)}
            aria-pressed={reorderMode} title={t('reorder-help')} aria-label={t('reorder')}>↕</button>
          <button className="nc-refresh" onClick={() => onSettings('nodes', false)} title={t('settings')}><Icon name="gear" size={18} /></button>
          <button className="nc-refresh" onClick={refresh} title={t('refresh')}><Icon name="refresh" size={18} /></button>
        </span>
      </header>

      <main className="nc-home-scroll">
      <LiveStripMobile view={liveHostView({ liveHost: hostByRoute[hostRouteKey([])], cells })} notice={liveNotice} />
      <PinPersistBanner pinError={pinError} onRetry={retryPinPersist} onDismiss={clearPinError} />
      {rosterTotal > 8 && (
        <input
          className="nc-filter" type="search" placeholder={t('filter-placeholder')} aria-label={t('filter-placeholder')}
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      )}

      {err && <div className="nc-err">{err}</div>}
      {actionNotice && <div className="nc-notice" role="status">{actionNotice}</div>}
      {fleetStale && <div className="nc-set-hint nc-fleet-stale" role="status">{t('fleet-stale')}</div>}
      {fleetOff !== null && (
        <div className="nc-set-hint nc-fleet-off" role="status">
          {t('fleet-off')}{fleetOff ? ` (${fleetOff})` : ''}
        </div>
      )}

      <section className="nc-group" data-position="local">
        <MobilePositionHeader label={t('position-local')} count={localItems.length} state={localView}
          dotClass="on" onToggle={() => updateView('local', { open: !localView.open })}
          onFilter={(filter) => updateView('local', { filter })} />
        {localView.open && localItems.map((item) => renderRosterItem(item, null, localRawItems))}
        {localView.open && sessions === null && <div className="nc-empty">{t('loading-fleet')}</div>}
        {localView.open && sessions !== null && localItems.length === 0 && !err && (
          <div className="nc-empty">{q ? t('no-match').replace('{q}', q) : t('no-sessions-short')}</div>
        )}
      </section>

      {/* Gruppi per-nodo remoto (Hydra): per ogni posizione mostriamo celle Fleet
          (attive e inattive, con engine/active) + tmux unmanaged. La salute e'
          quella del probe federato (NO verde hardcoded): 401/degraded -> warn con
          diagnostica. Tunnel del nodo diretto controllabile (power); peer inbound
          non gestito da qui -> niente power finto. */}
      {preferredNodeGroups.map((g) => {
        const hd = healthDot(g.health, { passive: 'warn' });
        const fleetNotice = g.fleetState === 'stale'
          ? t('fleet-stale') : g.fleetState === 'disabled' ? t('fleet-off') : '';
        const dotClass = g.fleetState === 'stale'
          ? 'warn' : hd || (g.status === 'up' ? 'on' : g.status === 'passive' ? '' : 'warn');
        const dotTitle = [g.health ? healthTitle(g.health) : nodeStateLabel(g), fleetNotice]
          .filter(Boolean).join(' · ');
        const route = g.route && g.route.length ? g.route : [g.name];
        const routeKey = route.join('/');
        const groupView = viewFor(routeKey);
        // Gruppo nodo VL (VL_NODES_IN_SIDEBAR): conteggio onesto dalla
        // sessione DICHIARATA (1 se attached, 0 altrimenti) — items.length
        // qui direbbe sempre 0 e mentirebbe. La riga apre la vista sessione,
        // non un terminale: niente pin/power/kill.
        if (g.kind === 'vl') {
          return (
            <section key={`nodo-vl-${routeKey}-${g.name}`} className="nc-group nc-node-order-wrap" data-position={routeKey}
              data-node-order-key={nodeKey(g)}>
              <MobilePositionHeader label={g.label || g.name} count={g.sessions.length} state={groupView}
                dotClass={dotClass} dotTitle={dotTitle}
                detail={nodeStateLabel(g)}
                onToggle={() => updateView(routeKey, { open: !groupView.open })}
                onFilter={(filter) => updateView(routeKey, { filter })} />
              {g.status === 'up' && groupView.open && g.sessions.map((vs) => (
                <div key={vs.key} className="nc-mcard nc-vl-session-row">
                  <button className="nc-mcard-main"
                    onClick={() => onOpenVlSession && onOpenVlSession(g.peer)}
                    aria-label={`${g.label || g.name}: ${vs.name}`}>
                    <span className="dot on" />
                    <span className="nc-mcard-text"><b>{vs.name}</b><small>{t('vl-events-title')}</small></span>
                  </button>
                </div>
              ))}
              {g.status === 'up' && groupView.open && g.sessions.length === 0 && (
                <div className="nc-empty">{t('no-sessions-short')}</div>
              )}
            </section>
          );
        }
        const { rawItems } = buildRemoteRoster(g);
        const items = sidebarItems(rawItems, pins, groupView.filter, sidebarOrder(orders, routeKey))
          .filter((item) => sidebarSearchVisible(item, q));
        const nodePower = g.direct && g.health && g.health.managed !== false ? (
          <button type="button" className={`nc-act power${g.tunnelStatus === 'up' ? ' on' : ''}`}
            disabled={nodeBusy === g.name} title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
            aria-label={`${g.tunnelStatus === 'up' ? t('power-off') : t('power-on')} ${g.label || g.name}`}
            onClick={() => onNodePower(g)}><Icon name="power" size={15} /></button>
        ) : null;
        const nodeActions = (
          <span className="nc-node-actions">
            <RosterHandle scope="node" position="nodes" itemKey={nodeKey(g)} label={g.label || g.name}
              onMove={(source, target) => moveNode(source, target, nodeGroups)}
              onStep={(delta) => stepNode(nodeKey(g), delta, nodeGroups)} />
            {g.direct && <button type="button" className="nc-node-rename" title={t('rename-node')}
              aria-label={`${t('rename-node')} ${g.label || g.name}`}
              onClick={() => promptNodeRename(g)}>✎</button>}
            {nodePower}
          </span>
        );
        return (
        <section key={`nodo-${routeKey}`} className="nc-group nc-node-order-wrap" data-position={routeKey}
          data-node-order-key={nodeKey(g)}>
              <MobilePositionHeader label={g.label || g.name} count={items.length} state={groupView}
                dotClass={dotClass} dotTitle={dotTitle}
                detail={g.status === 'up'
                  ? [nodeStateLabel(g), fleetNotice].filter(Boolean).join(' · ')
                  : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            onToggle={() => updateView(routeKey, { open: !groupView.open })}
            onFilter={(filter) => updateView(routeKey, { filter })}
            onRename={g.direct ? () => promptNodeRename(g) : null} action={nodeActions} />
          {g.status === 'up' && groupView.open && items.map((item) => renderRosterItem(item, g, rawItems))}
          {g.status === 'up' && groupView.open && items.length === 0 && (
            <div className="nc-empty">{q ? t('no-match').replace('{q}', q) : t('no-sessions-short')}</div>
          )}
        </section>
        );
      })}

      <footer className="nc-home-foot" onClick={copyEndpointUrl} title={t('copy-url')}>
        <span className="nc-home-meta">
          {version && <span className="nc-home-version">v{version}</span>}
          <span className="nc-home-endpoint">{endpointLabel} · {t('ssh-only')}</span>
        </span>
        <span className="nc-lang" onClick={(e) => e.stopPropagation()}>
          {LANGUAGES.map((lg, i) => (
            <span key={lg}>
              {i > 0 && ' · '}
              <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
            </span>
          ))}
        </span>
      </footer>
      </main>

      <button className="nc-fab" onClick={() => onSettings('fleet', true)} title={t('fleet-new-cell')} aria-label={t('fleet-new-cell')}>+</button>

      {powerCellLive && (
        <PowerSheet cell={powerCellLive} token={token} route={Array.isArray(powerCellLive.route) ? powerCellLive.route : []} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}

      {/* La finestra di anteprima, una per volta: `peekRow` si ri-risolve per
          chiave a ogni render, e se la cella è sparita dalla lista aggiornata
          non si rende niente (mai un fotogramma morto). La sorgente è
          controllata: «Guarda dal vivo» entra dal Flusso. */}
      {peekRow && (
        <CellPeek
          row={peekRow.row}
          token={token}
          initialSource={peekSource}
          panelPort={panelPortForRoute(peekRow.row.route || [], nodePanelPorts, panelPort)}
          liveHost={liveHostView({
            liveHost: hostByRoute[hostRouteKey(peekRow.row.route || [])],
            cells: peekRow.cells,
          })}
          onClose={() => { setPeekKey(null); setPeekSource('preview'); }}
        />
      )}

      {/* Le azioni della cella toccata, dal basso. Il contenuto è di
          CellActions (fase 1): qui si passano solo gli handler, e una voce
          senza handler non compare — è il suo contratto. Il busy copre anche
          l'avvio al boot in volo: un comando per volta sulla stessa cella. */}
      {menuCell && (() => {
        const { item, cell: c, route = [], canBoot } = menuCell;
        const stato = cellActionsState({ item, cellName: c.cell, route, pins, hostByRoute });
        const items = cellActionsItems({
          ...stato, canBoot, boot: bootEnabled(c, route), alive: !!c.tmux,
          handlers: cellActionHandlers(item, c, route),
        });
        return <CellActionsSheet cellName={c.cell} items={items}
          busy={menuBusy || bootBusy.has(bootCellKey(c.cell, route))}
          onClose={() => setMenuCell(null)} />;
      })()}
    </div>
  );
}

// La striscia Live (mobile): chi è la cella ospite della Live su QUESTO nodo,
// in una riga che sta in cima alla lista. La frase intera resta nel tooltip e
// l'esito dell'ultimo comando Live — dato dal foglio azioni — arriva qui, dove
// l'occhio sta già guardando. Presentazione mobile della stessa vista pura che
// la sidebar desktop usa: nessuna logica nuova, solo un'altra forma.
function LiveStripMobile({ view, notice }) {
  const hasHost = !!(view && view.cell);
  const frase = hasHost
    ? t('live-host-indicator')
      .replace('{cell}', view.cell)
      .replace('{mode}', t(view.mode ? `live-host-mode-${view.mode}` : 'live-host-mode-unknown'))
      .replace('{state}', t(`live-host-state-${view.state || 'none'}`))
    : t('live-host-indicator-none');
  return (
    <div className="nc-m-live-strip" data-state={view && view.state ? view.state : 'none'}
      title={notice ? `${frase} · ${t(notice.messageKey)}` : frase}>
      <span className={`nc-m-live-dot ${liveHostDotClass(view || {})}`} aria-hidden="true" />
      <span className="nc-m-live-testo">{hasHost ? view.cell : frase}</span>
      {notice && (
        <span className={`nc-m-live-notice${notice.ok ? ' ok' : ' ko'}`} role="status">
          {t(notice.messageKey).replace('{cell}', notice.cell || view.cell || '')}
        </span>
      )}
    </div>
  );
}

function MobilePositionHeader({
  label, count, state, dotClass = '', dotTitle = '', detail = '', onToggle, onFilter, onRename = null, action = null,
}) {
  return (
    <div className="nc-mobile-position-head"
      onContextMenu={onRename ? (event) => { event.preventDefault(); onRename(); } : undefined}>
      <button type="button" className="nc-mobile-position-toggle" onClick={onToggle}
        aria-expanded={state.open} aria-label={`${label} · ${t('node-sessions').replace('{n}', String(count))}`}>
        <span className="nc-mobile-chevron" aria-hidden="true">{state.open ? '⌄' : '›'}</span>
        <span className={`dot ${dotClass}`} title={dotTitle} />
        <span className="nc-mobile-position-copy">
          <b>{label}</b>
          <small>{detail || t('node-sessions').replace('{n}', String(count))}</small>
        </span>
      </button>
      <select className="nc-mobile-position-filter" value={state.filter}
        aria-label={`${label} · ${t('filter-placeholder')}`} title={t(`view-${state.filter}`)}
        onChange={(event) => onFilter(event.target.value)}>
        <option value="all">{t('view-all')}</option>
        <option value="pinned">{t('view-pinned')}</option>
        <option value="active">{t('view-active')}</option>
        <option value="off">{t('view-off')}</option>
        <option value="technical">{t('view-technical')}</option>
      </select>
      {action}
    </div>
  );
}
