import { useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { fleetStatus, fleetDefinitions } from '../lib/api.js';
import { ncControlCode, promptDeliveryBadge, promptInitialReasonKey, promptInitialStateKey } from '../lib/roster-view-model.js';
import './PowerSheet.css';
import EngineOptions from './fleet/EngineOptions.jsx';

// Launch editor CONDIVISO da Home (SessionList), Sidebar (App) e Impostazioni
// (FleetTab). Un solo posto per accendere/spegnere una cella, così non si
// duplicano UI né logica (z-index del launch sheet sopra Settings: vedi CSS).
//
//   cell:   oggetto cella flotta ({cell, engine, model, models, permissionPolicy,
//           permissionPolicies, active, boot, tmuxSession, route?})
//   route:  route Hydra ([] = locale)
//   autorevole/fleetStale: autorità della LETTURA che ha prodotto `cell`, la
//           stessa misura della card (roster-view-model). Il chiamante che non
//           la dichiara afferma una lettura corrente; un inventario conservato
//           (peer fermo, fleet locale caduto) non attesta nulla di corrente —
//           né la consegna del prompt né il controllo NC.
//   onConfirm(payload): il genitore esegue fleetUp/fleetDown. payload:
//     OFF  -> {action:'up', engine, model, permissionPolicy, boot}   ("Salva e avvia")
//     ON   -> {action:'down', boot}                                  ("Spegni" + rimuovi boot)
//
// Engine/modello/policy sono modificabili qui per la cella; la definizione profonda
// (provider, credenziali, engine custom) resta in Impostazioni → Flotta. La policy è
// PER-CELL PER-ENGINE (mappa permissionPolicies[engineId]): mai si tocca il default
// globale dell'engine. Ricorda ultimo modello E ultima policy per engine.
// Gli stati della consegna che hanno un QUANDO: solo gli esiti del lancio
// corrente portano l'ora del record; «non applicabile» e «non verificabile»
// non hanno un quando da prestare.
const CONSEGNA_CON_ORA = ['prompt-initial-submitted', 'prompt-initial-pending', 'prompt-initial-skipped'];

export default function PowerSheet({ cell, token, route = [], autorevole = true, fleetStale = false, onConfirm, onClose }) {
  useLang();
  const isOn = !!(cell && cell.active);
  const routeKey = Array.isArray(route) ? route.join('/') : '';

  // Definizioni + status sulla route corretta. Se il nodo non espone ancora le
  // definizioni, il foglio degrada a lifecycle+boot senza controlli fittizi.
  const [engines, setEngines] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) return;
      try {
        const st = await fleetStatus(token, routeKey ? routeKey.split('/') : []);
        if (!alive) return;
        setCanEdit(st.provider === 'builtin' && (st.capabilities || []).includes('edit'));
        if (st.provider === 'builtin' && (st.capabilities || []).includes('definitions')) {
          const def = await fleetDefinitions(token, routeKey ? routeKey.split('/') : []);
          if (!alive) return;
          const runtime = new Map((st.engines || []).map((e) => [e.id, e]));
          setEngines((def.engines || []).map((e) => ({
            id: e.id,
            label: e.label || e.id,
            client: e.managed?.client || '',
            models: [...new Set([...(runtime.get(e.id)?.models || []), ...(e.managedInfo?.models || [])])].filter(Boolean),
            defaultModel: e.managed?.model || e.managedInfo?.defaultModel || '',
            policyDefault: e.managed?.permissionPolicy || (e.managed?.client ? (e.managed.client === 'claude' ? 'unsafe' : 'standard') : 'standard'),
          })));
        }
      } catch (_) { /* best-effort: degrada a lifecycle-only */ }
    })();
    return () => { alive = false; };
  }, [token, routeKey]);

  // Stato del form, inizializzato dalla cella corrente.
  const firstEngine = (cell?.engine) || engines[0]?.id || '';
  const rememberedModel = (eng) => (cell?.models && cell.models[eng]) || '';
  const rememberedPolicy = (eng) => {
    const r = cell?.permissionPolicies && cell.permissionPolicies[eng];
    if (r === 'standard' || r === 'unsafe') return r;
    const def = engines.find((e) => e.id === eng);
    return def ? def.policyDefault : 'standard';
  };
  const [engine, setEngine] = useState(firstEngine);
  const [model, setStateModel] = useState(cell?.model || '');
  const initialPolicy = cell?.permissionPolicy === 'standard' || cell?.permissionPolicy === 'unsafe'
    ? cell.permissionPolicy
    : (cell?.permissionPolicies?.[cell?.engine] || '');
  const [policy, setPolicy] = useState(initialPolicy);
  const [boot, setBoot] = useState(cell?.boot ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Quando arriva la lista engine (effetto asincrono), allinea engine/model/policy
  // se la cella non li aveva espliciti. Idempotente sui valori già scelti dall'utente.
  useEffect(() => {
    if (!engines.length) return;
    setEngine((cur) => cur || firstEngine);
    setStateModel((cur) => cur || rememberedModel(cell?.engine || firstEngine) || '');
    setPolicy((cur) => (cur === 'standard' || cur === 'unsafe') ? cur : rememberedPolicy(cell?.engine || firstEngine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines.length]);

  const selected = useMemo(() => engines.find((e) => e.id === engine) || null, [engines, engine]);
  const supportsUnsafe = !!(selected && ['claude', 'codex', 'codex-vl', 'agy', 'kimi'].includes(selected.client));
  const isShell = selected?.client === 'shell';

  // P3-3 — La consegna del prompt iniziale, per esteso, vive nel FOGLIO:
  // stato, ORA LOCALE del record e MOTIVO leggibile. In card resta solo il
  // badge che chiede una risposta. Sotto, la supervisione NC con l'etichetta
  // intera — in card sopravvive solo «scaduto».
  const consegna = promptDeliveryBadge(cell, {
    currentLaunchId: cell?.launchId || null,
    autorevole: autorevole && !fleetStale,
    preserved: cell?.preserved === true,
  });
  const consegnaStatoKey = promptInitialStateKey(consegna.badge);
  const consegnaMotivoKey = promptInitialReasonKey(consegna.reason);
  const consegnaOra = consegna.ts !== null && CONSEGNA_CON_ORA.includes(consegnaStatoKey)
    ? `${t('prompt-initial-at')} ${new Date(consegna.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  const ncCodice = ncControlCode(cell, { fleetStale });

  // Cambio engine: ricorda modello e policy dell'engine precedente (lo fa il
  // backend via permissionPolicies/models) e ripristina quelli ricordati per il nuovo.
  function chooseEngine(id) {
    setEngine(id);
    const def = engines.find((e) => e.id === id);
    setStateModel(rememberedModel(id) || def?.defaultModel || '');
    setPolicy(rememberedPolicy(id));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (isOn) {
        await onConfirm({ action: 'down', boot });
      } else {
        const effectivePolicy = policy === 'standard' || policy === 'unsafe'
          ? policy
          : (selected?.policyDefault || 'standard');
        await onConfirm({
          action: 'up',
          ...(canEdit ? {
            engine,
            model: model || '',
            ...(supportsUnsafe
              ? { permissionPolicy: effectivePolicy }
              : (selected?.client === 'pi' ? { permissionPolicy: 'standard' } : {})),
          } : {}),
          boot,
        });
      }
      onClose();
    } catch (er) { setErr(String((er && er.message) || er)); setBusy(false); }
  }

  return (
    <div className="nc-sheet-overlay nc-launch-overlay" onClick={onClose}>
      <form className="nc-sheet nc-power-sheet nc-launch-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="nc-sheet-head">
          <b>{cell?.cell}</b>
          <span className="nc-sheet-state">{isOn ? t('state-on') : t('state-off')}</span>
        </div>

        {isOn ? (
          <>
            <div className="nc-power-config">
              <span>{t('engine')}</span><b>{cell?.engine || '—'}</b>
              {cell?.model && <small>{t('model')}: {cell.model}</small>}
              <small>{t('power-on-hint')}</small>
            </div>
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('remove-boot')}
            </label>
          </>
        ) : (
          <>
            {canEdit && engines.length > 0 ? (
              <div className="nc-launch-fields">
                <label className="nc-field">{t('engine')}
                  <select value={engine} onChange={(e) => chooseEngine(e.target.value)}>
                    <EngineOptions engines={engines} />
                  </select>
                </label>
                {!isShell && <label className="nc-field">{t('model')}
                  <input value={model} list="nc-launch-models" placeholder={t('model-default')} onChange={(e) => setStateModel(e.target.value)} />
                  <datalist id="nc-launch-models">{(selected?.models || []).map((m) => <option key={m} value={m} />)}</datalist>
                </label>}
                {supportsUnsafe ? (
                  <label className="nc-field">{t('permissions')}
                    <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
                      <option value="standard">{t('fleet-standard-permissions')}</option>
                      <option value="unsafe">{t('fleet-unsafe-permissions')}</option>
                    </select>
                  </label>
                ) : (
                  <small className="nc-note">{t('fleet-standard-permissions')}</small>
                )}
                {supportsUnsafe && policy === 'unsafe' && <small className="nc-err">{t('fleet-unsafe-warning')}</small>}
                <small className="nc-note">{isShell ? t('fleet-shell-launch-help') : t('launch-engine-help')}</small>
              </div>
            ) : (
              <div className="nc-power-config">
                <span>{t('engine')}</span><b>{cell?.engine || '—'}</b>
                {cell?.model && <small>{t('model')}: {cell.model}</small>}
                <small>{t('launch-unavailable-hint')}</small>
              </div>
            )}
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('boot-persist')}
            </label>
          </>
        )}

        {/* Prompt iniziale + supervisione NC: i dettagli che la card non
            porta. Stessa veste di nc-power-config, nessun componente nuovo. */}
        <div className="nc-power-config nc-prompt-initial">
          <span>{t('prompt-initial-title')}</span>
          <b>{[t(consegnaStatoKey), consegnaOra].filter(Boolean).join(' ')}</b>
          {consegnaMotivoKey && <small>{t(consegnaMotivoKey)}</small>}
          {cell?.tmux === true && (
            <small>{t('prompt-initial-control')}: {t(`nc-control-${ncCodice}`)}</small>
          )}
        </div>

        {err && <div className="nc-err">{err}</div>}

        <div className="nc-sheet-actions">
          {/* Cancel resta sempre attivo: chiude il foglio e l'azione continua
              in background — l'esito arriva come notice del roster, non come
              errore nel foglio. L'unico pulsante disabilitato durante il
              lavoro è il primario, che mostra cosa sta facendo. */}
          <button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="nc-btn primary" disabled={busy}>
            {busy
              ? (isOn ? t('power-stopping') : t('power-starting'))
              : (isOn ? t('power-off') : t('save-and-start'))}
          </button>
        </div>
      </form>
    </div>
  );
}
