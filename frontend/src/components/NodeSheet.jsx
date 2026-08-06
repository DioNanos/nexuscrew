import { useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { nodeAction, removeNode, updateNode, setNodeVisibility, sendVlNodeCommand, fleetDefinitions } from '../lib/api.js';
import { tunnelInfo, isValidLabel } from '../lib/settings-model.js';
import { nodeDetailModel, selectionCandidates, cellScopeGrants, cellScopeCandidates } from '../lib/node-detail.js';
import { vlNodeActions, vlCommandStatus, vlHasPrompt, vlDefaultArgs, VL_PROMPT_MAX } from '../lib/vl-node-detail.js';
import DetailSheet, { SheetSection } from './DetailSheet.jsx';
import Icon from './Icon.jsx';

// Il dettaglio di UN nodo. Prima viveva dentro la riga: visibilita', spunte di
// tutti i nodi della rete, editor e conferma di rimozione, tutto aperto insieme
// in una card che su un telefono non stava in piedi. Qui la riga porta identita'
// e riassunto, e questo foglio porta il resto.
//
// Il foglio non decide niente da solo: il modello sta in lib/node-detail.js,
// provato senza React. Qui restano le chiamate e la forma.
export default function NodeSheet({ node, nodes, token, readonly, refresh, onClose }) {
  useLang();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [test, setTest] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  // Le celle di QUESTA installazione, per lo scope NC-E. `null` = non ancora
  // chieste: il modello lo distingue da «elenco vuoto» e non marca le
  // concessioni come sconosciute mentre la risposta arriva.
  const [localCells, setLocalCells] = useState(null);
  // Distinto da `localCells`: un elenco che non e' arrivato NON e' un elenco
  // vuoto. Confonderli fa leggere un errore di rete come «le celle concesse non
  // esistono piu'», cioe' come una revoca che nessuno ha fatto.
  const [cellsFailed, setCellsFailed] = useState(false);
  const [cellQuery, setCellQuery] = useState('');
  const [cellPicking, setCellPicking] = useState(false);
  // L'ultimo comando VL che QUESTA sessione ha sottomesso — {id, kind,
  // submittedAt} | null. Serve a distinguere "inviato da me, in attesa
  // dell'ack" da un lastAck del nodo che appartiene a un comando precedente
  // (design NC_UI_NODI_VL step 2: "inviato" non e' "fatto").
  const [vlPending, setVlPending] = useState(null);
  // Campo prompt (verbo con argomenti): il click sul verbo APRE il campo, non
  // spara. Il testo resta nel campo se l'invio fallisce (ritentabile).
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');

  const model = useMemo(
    () => nodeDetailModel(node, nodes, { readonly, busy: !!busy }),
    [node, nodes, readonly, busy],
  );
  if (!model) return null;
  const { identity, reach, authority, exposure, grants, actions, canEditVisibility, canEditCellScope, cellScope } = model;
  const ti = identity.routed ? { up: reach.up, since: null } : tunnelInfo(node.tunnel, Date.now());

  const guard = async (key, fn) => {
    setErr(null); setBusy(key);
    try { await fn(); } catch (e) { setErr(String((e && e.message) || e)); }
    setBusy(null);
  };

  const runAction = (action) => {
    if (action === 'edit') {
      setEditing({
        label: node.label || node.name,
        ssh: node.ssh || '',
        sshPort: node.sshPort ? String(node.sshPort) : '',
        autostart: node.autostart === true,
        visibility: node.visibility || 'network',
      });
      return;
    }
    if (action === 'remove') { setConfirmRemove(true); return; }
    guard(`${node.name}:${action}`, async () => {
      const result = await nodeAction(token, node.name, action);
      if (action === 'test') setTest(result);
      await refresh();
    });
  };

  // Un comando VL: il POST risponde SOLO {id, status:'submitted'} — l'esito
  // vero arriva dopo, in node.lastAck, al prossimo refresh(). Tracciare l'id
  // qui e' cio' che permette a vlCommandStatus di distinguere "inviato da
  // questo click" da un ack di un comando precedente (mai un successo
  // ottimistico prima che il server lo confermi).
  const runVlCommand = (kind, args = vlDefaultArgs(kind)) => guard(`${node.nodeId}:${kind}`, async () => {
    // La route dell'owner (step 3, NC_UI_NODI_VL_REMOTI): un nodo remoto ha
    // `node.route` non vuota, e il comando DEVE arrivare li', non a
    // /api/vl-nodes locale — sbagliare instrada il comando al device
    // sbagliato (invariante 3 del brief).
    const result = await sendVlNodeCommand(token, node.nodeId, kind, args, node.route || []);
    setVlPending({ id: result.id, kind, submittedAt: Date.now() });
    await refresh();
  });

  // Invio del prompt: trim + bound come il resto della catena (4 KiB sul
  // device); il vuoto non parte proprio. Il campo si svuota SOLO a invio
  // riuscito — su errore il testo resta li', pronto al retry.
  const sendPrompt = () => {
    const text = promptText.trim().slice(0, VL_PROMPT_MAX);
    if (!text) return;
    guard(`${node.nodeId}:prompt`, async () => {
      const result = await sendVlNodeCommand(token, node.nodeId, 'prompt', { text }, node.route || []);
      setVlPending({ id: result.id, kind: 'prompt', submittedAt: Date.now() });
      setPromptText('');
      setPromptOpen(false);
      await refresh();
    });
  };

  const saveEdit = () => {
    if (!isValidLabel(editing.label)) { setErr(t('err-label')); return; }
    const patch = identity.inbound
      ? { label: editing.label, visibility: editing.visibility, selected: editing.visibility === 'selected' ? [...(node.selected || [])] : [] }
      : {
        label: editing.label, ssh: editing.ssh, autostart: editing.autostart,
        ...(editing.sshPort ? { sshPort: Number(editing.sshPort) } : {}),
      };
    return guard(`${node.name}:edit`, async () => {
      await updateNode(token, node.name, patch);
      setEditing(null);
      await refresh();
    });
  };

  const applyVisibility = (visibility, selected) => guard(`${node.name}:visibility`, async () => {
    await setNodeVisibility(token, node.name, visibility, selected);
    await refresh();
  });

  const candidates = canEditVisibility && node.visibility === 'selected'
    ? selectionCandidates(node, nodes, query) : [];

  // Lo scope celle si applica con la stessa route di edit usata dalla CLI, che
  // normalizza da sola: passando a un modo diverso da `selected` l'elenco
  // concesso viene CANCELLATO lato server, non conservato. Qui quindi non si
  // manda `cells` quando non ha significato — mandarlo direbbe una cosa che il
  // server poi ignora, e il primo a confondersi sarebbe chi legge questo file.
  const applyCellScope = (cellVisibility, cells) => guard(`${node.name}:cell-scope`, async () => {
    await updateNode(token, node.name, cellVisibility === 'selected'
      ? { cellVisibility, cells: Array.isArray(cells) ? cells : (node.cells || []) }
      : { cellVisibility });
    await refresh();
  });

  // Le celle si chiedono una volta sola, e solo a chi apre davvero questa
  // sezione: un foglio nodo aperto per riavviare un tunnel non deve pagare una
  // richiesta in piu'.
  // `retry` esiste per un caso solo: il click su «aggiungi una cella» dopo un
  // fallimento. Senza, il flag faceva uscire subito la funzione e il picker si
  // apriva VUOTO con "nessuna cella corrisponde" — un messaggio che dice la
  // cosa sbagliata, perche' il problema non e' che non ci sono celle, e' che
  // non si e' riusciti a chiederle. Rilievo dell'audit.
  const ensureCells = async ({ retry = false } = {}) => {
    if (retry && cellsFailed) setCellsFailed(false);
    else if (localCells !== null || cellsFailed) return;
    try {
      const res = await fleetDefinitions(token);
      setLocalCells(Array.isArray(res && res.cells) ? res.cells : []);
    } catch (_) {
      // `localCells` resta null di proposito: e' il valore che il modello legge
      // come «non lo so», e nessuna concessione viene marcata inesistente. Il
      // flag ferma il ritentativo — un errore di rete non deve trasformare
      // l'apertura del foglio in un ciclo di richieste — e accende l'avviso.
      setCellsFailed(true);
    }
  };

  // Su un nodo GIA' ristretto l'elenco serve subito, non al primo click: senza,
  // una cella concessa che non esiste piu' resta indistinguibile da una viva
  // finche' qualcuno non apre il picker — e chi apre il foglio per controllare
  // i permessi e' proprio chi ha bisogno di saperlo. Una sola richiesta, e solo
  // per i nodi che hanno un elenco da verificare.
  useEffect(() => {
    if (canEditCellScope && cellScope === 'selected' && localCells === null) ensureCells();
    // `ensureCells` e' stabile nei fatti (guardia su localCells) e includerla
    // rifarebbe il giro a ogni render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEditCellScope, cellScope, localCells]);

  const cellGrants = cellScopeGrants(node, localCells);
  const cellCandidates = cellScope === 'selected'
    ? cellScopeCandidates(node, localCells, cellQuery) : [];

  const status = (
    <span className={`nc-set-tunnel${reach.up ? ' up' : ''}`}>
      {t(reach.key)}{ti.since ? ` · ${ti.since}` : ''}
    </span>
  );

  // I comandi VL vengono da `node.capabilities` (dichiarate dal device), non
  // da una lista fissa qui — un comando non dichiarato non ha un bottone.
  const isVl = node.kind === 'vl';
  const vlActions = isVl ? vlNodeActions(node) : [];
  const vlStatus = isVl ? vlCommandStatus(node, vlPending) : null;
  const vlCommandLabel = (kind) => {
    const key = `vl-cmd-${kind}`;
    const label = t(key);
    // Un comando dichiarato ma senza traduzione (device futuro, capability
    // nuova) mostra il nome grezzo invece di sparire o mostrare la chiave.
    return label === key ? kind : label;
  };

  const footer = isVl
    ? [
      ...vlActions.map((kind) => (
        <button key={kind} type="button" className="nc-btn ghost"
          disabled={!!busy || readonly} title={readonly ? t('settings-readonly') : undefined}
          onClick={() => runVlCommand(kind)}>
          {vlCommandLabel(kind)}
        </button>
      )),
      // `prompt` non e' un bottone che spara: apre il campo (verbo con args).
      ...(vlHasPrompt(node) ? [(
        <button key="prompt" type="button" className={`nc-btn ghost${promptOpen ? ' on' : ''}`}
          disabled={!!busy || readonly} title={readonly ? t('settings-readonly') : undefined}
          onClick={() => setPromptOpen((v) => !v)}>
          {vlCommandLabel('prompt')}
        </button>
      )] : []),
    ]
    : actions.map((a) => (
      <button key={a.action} type="button" className={`nc-btn ${a.danger ? 'danger' : 'ghost'}`}
        disabled={a.disabled} title={a.disabled && readonly ? t('settings-readonly') : undefined}
        onClick={() => runAction(a.action)}>
        {a.action === 'remove' ? <><Icon name="trash" size={14} /> {t(a.key)}</> : t(a.key)}
      </button>
    ));

  return (
    <DetailSheet title={identity.title} subtitle={identity.name} status={status} footer={footer} onClose={onClose}>
      <SheetSection title={t('node-detail-reach')}>
        <dl className="nc-detail-facts">
          {identity.route && <><dt>{t('node-detail-route')}</dt><dd>{identity.route.join(' › ')}</dd></>}
          {identity.ssh && <><dt>{t('node-detail-ssh')}</dt><dd>{identity.ssh}{node.sshPort ? `:${node.sshPort}` : ''}</dd></>}
          {identity.transport && <><dt>{t('node-detail-transport')}</dt><dd>{identity.transport}</dd></>}
          {/* Owner del nodo VL (step 3, invariante 2): con piu' owner in
              rete, due device con la stessa label sono distinguibili solo
              cosi'. Un nodo locale (`ownerLabel` assente) non mostra questa
              riga — non c'e' ambiguita' da risolvere. */}
          {isVl && node.ownerLabel && <><dt>{t('node-detail-owner')}</dt><dd>{node.ownerLabel}</dd></>}
        </dl>
        {node.health?.detail && (
          // Altro punto dove le due forme divergono: la salute Fleet usa
          // `health.status` ('healthy'/'passive'/...), quella VL usa
          // `health.state` ('starting'|'running'|'stopped'|'degraded'|
          // 'error', lib/vl-nodes/broker.js) — leggere il campo sbagliato
          // avrebbe mostrato un nodo VL sano dentro un riquadro rosso
          // "guasto" per ogni stato, dato che `.status` e' sempre undefined.
          <div className={`nc-set-test${
            isVl
              ? (node.health.state === 'running' ? ' ok' : node.health.state === 'starting' ? '' : ' ko')
              : (node.health.status === 'healthy' ? ' ok' : node.health.status === 'passive' ? '' : ' ko')
          }`}>
            {node.health.detail}
          </div>
        )}
        {test && <div className={`nc-set-test${test.ok ? ' ok' : ' ko'}`}>{test.result}{test.detail ? ` — ${test.detail}` : ''}</div>}
      </SheetSection>

      {/* Comandi VL: "inviato" non e' "fatto" (design NC_UI_NODI_VL step 2).
          I bottoni sono nel footer (letti da capabilities); qui va solo lo
          STATO dell'ultimo comando — mai un successo prima che il server lo
          confermi in lastAck. */}
      {isVl && (
        <SheetSection title={t('node-detail-command')}>
          {vlActions.length === 0 && !vlHasPrompt(node) && <small className="nc-set-hint">{t('vl-no-commands')}</small>}
          {promptOpen && (
            <div className="nc-vl-prompt">
              <textarea
                value={promptText}
                maxLength={VL_PROMPT_MAX}
                placeholder={t('vl-prompt-placeholder')}
                aria-label={t('vl-prompt-placeholder')}
                disabled={!!busy || readonly}
                onChange={(e) => setPromptText(e.target.value)}
              />
              <button type="button" className="nc-btn primary"
                disabled={!!busy || readonly || !promptText.trim()}
                onClick={sendPrompt}>
                {t('vl-prompt-send')}
              </button>
            </div>
          )}
          {vlStatus && (
            <div className={`nc-set-test${vlStatus.phase === 'done' ? (vlStatus.status === 'ok' ? ' ok' : ' ko') : ''}`}>
              {vlStatus.kind && `${vlCommandLabel(vlStatus.kind)}: `}
              {vlStatus.phase === 'submitted' && t('vl-cmd-phase-submitted')}
              {vlStatus.phase === 'inflight' && t('vl-cmd-phase-inflight')}
              {vlStatus.phase === 'done' && t(vlStatus.status === 'ok' ? 'vl-cmd-phase-done-ok' : 'vl-cmd-phase-done-error')}
              {vlStatus.phase === 'done' && vlStatus.result?.detail ? ` — ${vlStatus.result.detail}` : ''}
            </div>
          )}
        </SheetSection>
      )}

      {/* La conversazione NON vive piu' qui (VL_NODES_IN_SIDEBAR, 2026-08-06):
          questa scheda serve ad accoppiare e comandare, e una colonna da ~30
          caratteri spezza il testo a meta' parola. La sessione si apre dalla
          sidebar, nella vista larga (VlSessionView), che e' la sua sede. */}

      {/* La sezione che potrebbe mentire piu' facilmente di tutte. Oggi non
          esistono poteri per-nodo: la verita' e' che un nodo accoppiato e'
          fidato quanto l'operatore, ed e' scritta qui perche' e' qui che si
          verrebbe a cercarla. La visibilita' NON e' un limite di potere e sta
          apposta in un'altra sezione. `authority.grants` e' lo slot: quando i
          grant esisteranno, l'elenco compare qui e la frase qui sopra cambia. */}
      <SheetSection title={t('node-detail-authority')}>
        <div className="nc-set-info">{t(authority.key)}</div>
        {/* La frase diceva che i poteri per-nodo «non esistono ancora»: con lo
            scope celle non e' piu' vero, ed era scritta DUE sezioni sopra il
            controllo che li concede. Due varianti perche' «qui sotto» e' una
            promessa: su un nodo in transito quella sezione non c'e', e
            mandarci l'operatore sarebbe peggio del silenzio. */}
        {authority.grants.length === 0 && (
          <small className="nc-set-hint">
            {t(canEditCellScope ? 'authority-no-grants' : 'authority-no-grants-elsewhere')}
          </small>
        )}
      </SheetSection>

      <SheetSection title={t('node-detail-network-view')}>
        {/* Per un nodo VL si rende direttamente `exposure.key` (oggi
            "federated": i nodi VL sono federati come ogni altra risorsa,
            federation di /vl-nodes/* ripristinata 2026-08-05). Il ramo non-VL
            resta l'espressione originale su `exposure.shared`: nessun cambio
            di comportamento per i nodi Fleet. */}
        <div className="nc-set-info">{t(isVl ? exposure.key : (exposure.shared ? 'peer-shared' : 'peer-private'))}</div>
        {canEditVisibility && <>
          <label className="nc-field">{t('peer-visibility')}
            <select value={node.visibility || 'network'} disabled={readonly || !!busy}
              onChange={(e) => applyVisibility(e.target.value)}>
              <option value="network">{t('visibility-network')}</option>
              <option value="relay-only">{t('visibility-relay')}</option>
              <option value="selected">{t('visibility-selected')}</option>
            </select>
          </label>
          {node.visibility === 'selected' && <div className="nc-detail-grants">
            {grants.length === 0 && <small className="nc-set-hint">{t('node-grant-none')}</small>}
            {grants.map((g) => (
              <div key={g.id} className={`nc-detail-grant${g.known ? '' : ' unknown'}`}>
                <span>{g.label}{g.known ? '' : ` — ${t('node-grant-unknown')}`}</span>
                <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={() => applyVisibility('selected', (node.selected || []).filter((id) => id !== g.id))}>
                  {t('node-grant-remove')}
                </button>
              </div>
            ))}
            {/* Si aggiunge cercando, non spuntando: con quaranta nodi in rete
                una lista di caselle e' piu' lunga del foglio e nasconde le
                concessioni vere in mezzo a quelle mai date. */}
            {!picking && <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
              onClick={() => { setPicking(true); setQuery(''); }}>{t('node-grant-add')}</button>}
            {picking && <div className="nc-detail-picker">
              <input value={query} placeholder={t('node-grant-search')} disabled={readonly || !!busy}
                onChange={(e) => setQuery(e.target.value)} />
              <div className="nc-detail-picker-list">
                {candidates.length === 0 && <small className="nc-set-hint">{t('node-grant-no-candidates')}</small>}
                {candidates.map((c) => (
                  <button key={c.id} type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                    onClick={async () => {
                      await applyVisibility('selected', [...(node.selected || []), c.id]);
                      setPicking(false); setQuery('');
                    }}>{c.label}</button>
                ))}
              </div>
              <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => { setPicking(false); setQuery(''); }}>{t('cancel')}</button>
            </div>}
          </div>}
        </>}
      </SheetSection>

      {/* Scope celle (NC-E). Sezione a se' e non dentro "vista di rete": la
          visibilita' governa il TRANSITO (attraverso chi passa il traffico),
          questo governa l'ACCESSO (cosa quel nodo vede e puo' toccare qui).
          Metterli insieme fa credere che uno implichi l'altro. */}
      {canEditCellScope && (
        <SheetSection title={t('cell-scope')}>
          <small className="nc-set-hint">{t('cell-scope-help')}</small>
          <label className="nc-field">
            <select value={cellScope} aria-label={t('cell-scope')} disabled={readonly || !!busy}
              onChange={(e) => { if (e.target.value === 'selected') ensureCells(); applyCellScope(e.target.value); }}>
              <option value="all">{t('cell-scope-all')}</option>
              <option value="none">{t('cell-scope-none')}</option>
              <option value="selected">{t('cell-scope-selected')}</option>
            </select>
          </label>
          {/* Il server AZZERA l'elenco quando si lascia `selected` — ed e'
              giusto cosi': un residuo tornerebbe buono al ritorno, concedendo
              in silenzio cio' che si credeva tolto. Ma senza avviso l'operatore
              perde le celle scelte per aver guardato un altro modo un istante.
              Si informa, non si blocca: una conferma su ogni cambio sarebbe
              rumore su tre scelte innocue su quattro. */}
          {cellScope === 'selected' && cellGrants.length > 0 && (
            <small className="nc-set-hint">{t('cell-scope-reset-warning')}</small>
          )}
          {cellsFailed && <small className="nc-set-hint">{t('cell-scope-list-unavailable')}</small>}
          {cellScope === 'selected' && <div className="nc-detail-grants">
            {cellGrants.length === 0 && <small className="nc-set-hint">{t('cell-scope-none-granted')}</small>}
            {cellGrants.map((g) => (
              <div key={g.id} className={`nc-detail-grant${g.known ? '' : ' unknown'}`}>
                <span>{g.label}{g.known ? '' : ` \u2014 ${t('cell-scope-unknown')}`}</span>
                <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={() => applyCellScope('selected', (node.cells || []).filter((c) => c !== g.id))}>
                  {t('node-grant-remove')}
                </button>
              </div>
            ))}
            {!cellPicking && <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
              onClick={async () => { await ensureCells({ retry: true }); setCellPicking(true); setCellQuery(''); }}>
              {t('cell-scope-add')}
            </button>}
            {cellPicking && <div className="nc-detail-picker">
              <input value={cellQuery} placeholder={t('cell-scope-search')} disabled={readonly || !!busy}
                onChange={(e) => setCellQuery(e.target.value)} />
              <div className="nc-detail-picker-list">
                {cellCandidates.length === 0 && <small className="nc-set-hint">{t('cell-scope-no-candidates')}</small>}
                {cellCandidates.map((c) => (
                  <button key={c.id} type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                    onClick={async () => {
                      await applyCellScope('selected', [...(node.cells || []), c.id]);
                      setCellPicking(false); setCellQuery('');
                    }}>{c.label}</button>
                ))}
              </div>
              <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => { setCellPicking(false); setCellQuery(''); }}>{t('cancel')}</button>
            </div>}
          </div>}
        </SheetSection>
      )}

      {editing && (
        <SheetSection title={t('edit')}>
          <label className="nc-field">{t('node-display-label')}
            <input value={editing.label} disabled={!!busy}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
          </label>
          {identity.inbound ? (
            <label className="nc-field">{t('peer-visibility')}
              <select value={editing.visibility} disabled={!!busy}
                onChange={(e) => setEditing({ ...editing, visibility: e.target.value })}>
                <option value="network">{t('visibility-network')}</option>
                <option value="relay-only">{t('visibility-relay')}</option>
                <option value="selected">{t('visibility-selected')}</option>
              </select>
            </label>
          ) : <>
            <label className="nc-field">{t('node-ssh-label')}
              <input value={editing.ssh} disabled={!!busy}
                onChange={(e) => setEditing({ ...editing, ssh: e.target.value })} />
            </label>
            <label className="nc-field">{t('node-ssh-port-label')}
              <input inputMode="numeric" value={editing.sshPort} disabled={!!busy}
                onChange={(e) => setEditing({ ...editing, sshPort: e.target.value.replace(/[^0-9]/g, '').slice(0, 5) })} />
            </label>
            <label className="nc-check"><input type="checkbox" checked={editing.autostart} disabled={!!busy}
              onChange={(e) => setEditing({ ...editing, autostart: e.target.checked })} /> {t('boot-persist')}</label>
          </>}
          <div className="nc-set-row">
            <button type="button" className="nc-btn primary" disabled={!!busy} onClick={saveEdit}>{t('save')}</button>
            <button type="button" className="nc-btn ghost" disabled={!!busy} onClick={() => setEditing(null)}>{t('cancel')}</button>
          </div>
        </SheetSection>
      )}

      {confirmRemove && (
        <div className="nc-set-confirm">
          <b>{t('node-remove-confirm').replace('{name}', identity.title)}</b>
          <small>{t('node-remove-warning')}</small>
          <div className="nc-set-row">
            <button type="button" className="nc-btn danger" disabled={!!busy}
              onClick={() => guard(`${node.name}:remove`, async () => {
                await removeNode(token, node.name);
                setConfirmRemove(false);
                await refresh();
                // Il nodo non esiste piu': lasciare aperto il suo foglio
                // mostrerebbe lo stato di un peer rimosso.
                onClose && onClose();
              })}>{t('delete')}</button>
            <button type="button" className="nc-btn ghost" disabled={!!busy} onClick={() => setConfirmRemove(false)}>{t('cancel')}</button>
          </div>
        </div>
      )}

      {err && <div className="nc-err">{err}</div>}
    </DetailSheet>
  );
}
