import { useCallback, useEffect, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import {
  apiFetch, getSettings, getNodes, saveConfig, rotateToken,
  addNode, removeNode, nodeAction, setNodeRole, regenService,
} from '../lib/api.js';
import { validateNodeForm, validateRendezvousForm, tunnelInfo } from '../lib/settings-model.js';
import { getPushState, subscribePush, unsubscribePush } from '../lib/push.js';
import Icon from './Icon.jsx';
import FleetTab from './FleetTab.jsx';
import './SettingsPanel.css';

// Pannello settings (design §5, B2-UI). Stessa struttura a schede su desktop
// (overlay nel workspace) e mobile (full-screen via CSS). Tre schede:
//   ruoli   — toggle client/node (POST /config, POST /node-role)
//   nodi    — elenco nodi + stato tunnel (poll GET /api/nodes) + azioni
//   sistema — token rotate (conferma esplicita), rigenerazione service, info
// Invarianti UI: token MAI mostrato; ogni failure API mostrata con la causa
// esplicita (jsonFetch propaga j.error); in READONLY i mutanti sono disabilitati
// con motivo visibile (test/up/down/restart restano attivi: non sono gated).

// Bottone "copia" con feedback: la riga authorized_keys e' una pubkey con
// restrict/permitopen — NON un segreto (contratto B2-API).
function CopyLine({ text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch (_) { /* clipboard non disponibile (no HTTPS/permessi): resta selezionabile a mano */ }
  };
  return (
    <div className="nc-set-copyline">
      <code>{text}</code>
      <button type="button" className="nc-btn ghost" onClick={copy}>
        <Icon name="copy" size={14} /> {done ? t('copied') : t('copy')}
      </button>
    </div>
  );
}

// Blocco riga authorized_keys post add/node-role (hint + copia).
export function AuthorizedKeysBlock({ line }) {
  if (!line) return null;
  return (
    <div className="nc-set-akeys">
      <div className="nc-set-hint">{t('authorized-keys-hint')}</div>
      <CopyLine text={line} />
    </div>
  );
}

// --- scheda RUOLI -------------------------------------------------------------
function RolesTab({ token, settings, readonly, refresh }) {
  const roles = (settings && settings.roles) || { client: false, node: false };
  const hasRendezvous = !!(settings && settings.rendezvous);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [nodeForm, setNodeForm] = useState(null); // {ssh, publishedPort} quando serve il rendezvous
  const [akeys, setAkeys] = useState(null);

  const toggleClient = async (checked) => {
    setErr(null); setBusy(true);
    try { await saveConfig(token, { roles: { client: checked } }); await refresh(); }
    catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const applyNodeRole = async (body) => {
    setErr(null); setBusy(true);
    try {
      const j = await setNodeRole(token, body);
      setAkeys(j.authorizedKeys || null);
      setNodeForm(null);
      await refresh();
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const toggleNode = (checked) => {
    setAkeys(null);
    if (!checked) return applyNodeRole({ enabled: false });
    if (hasRendezvous) return applyNodeRole({ enabled: true });
    setNodeForm({ ssh: '', publishedPort: '' });     // serve il rendezvous: form inline
  };

  const submitRendezvous = () => {
    const v = validateRendezvousForm(nodeForm, hasRendezvous);
    if (!v.ok) return setErr(t(v.error));
    applyNodeRole({ enabled: true, ...v.value });
  };

  return (
    <div className="nc-set-tab">
      <label className="nc-check">
        <input type="checkbox" checked={!!roles.client} disabled={readonly || busy}
          onChange={(e) => toggleClient(e.target.checked)} />
        <span><b>{t('role-client')}</b><small>{t('role-client-desc')}</small></span>
      </label>
      <label className="nc-check">
        <input type="checkbox" checked={!!roles.node} disabled={readonly || busy}
          onChange={(e) => toggleNode(e.target.checked)} />
        <span><b>{t('role-node')}</b><small>{t('role-node-desc')}</small></span>
      </label>
      {settings && settings.rendezvous && (
        <div className="nc-set-info">rendezvous: {settings.rendezvous.ssh}{settings.rendezvous.publishedPort ? ` :${settings.rendezvous.publishedPort}` : ''}</div>
      )}
      {nodeForm && (
        <div className="nc-set-form">
          <input placeholder={t('rendezvous-ssh')} value={nodeForm.ssh}
            onChange={(e) => setNodeForm({ ...nodeForm, ssh: e.target.value })} />
          <input placeholder={t('published-port')} inputMode="numeric" value={nodeForm.publishedPort}
            onChange={(e) => setNodeForm({ ...nodeForm, publishedPort: e.target.value })} />
          <div className="nc-sheet-actions">
            <button type="button" className="nc-btn ghost" onClick={() => setNodeForm(null)}>{t('cancel')}</button>
            <button type="button" className="nc-btn primary" disabled={busy} onClick={submitRendezvous}>{t('enable')}</button>
          </div>
        </div>
      )}
      <AuthorizedKeysBlock line={akeys} />
      {err && <div className="nc-err">{err}</div>}
    </div>
  );
}

// --- scheda NODI ---------------------------------------------------------------
function NodesTab({ token, nodes, readonly, refresh }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);        // `${name}:${action}` in corso
  const [testResult, setTestResult] = useState({}); // name -> {ok, result, detail}
  const [form, setForm] = useState({ name: '', ssh: '', remotePort: '' });
  const [akeys, setAkeys] = useState(null);
  const now = Date.now();

  const run = async (name, action) => {
    setErr(null); setBusy(`${name}:${action}`);
    try {
      const j = await nodeAction(token, name, action);
      if (action === 'test') setTestResult((m) => ({ ...m, [name]: j }));
      await refresh();
    } catch (e) { setErr(`${name}: ${String(e.message || e)}`); }
    setBusy(null);
  };

  const onRemove = async (name) => {
    if (!window.confirm(t('node-remove-confirm').replace('{name}', name))) return;
    setErr(null); setBusy(`${name}:remove`);
    try { await removeNode(token, name); await refresh(); }
    catch (e) { setErr(`${name}: ${String(e.message || e)}`); }
    setBusy(null);
  };

  const onAdd = async () => {
    setErr(null); setAkeys(null);
    const v = validateNodeForm(form);
    if (!v.ok) return setErr(t(v.error));
    setBusy('add');
    try {
      const j = await addNode(token, v.value);
      setAkeys(j.authorizedKeys || null);
      setForm({ name: '', ssh: '', remotePort: '' });
      await refresh();
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(null);
  };

  return (
    <div className="nc-set-tab">
      {(nodes || []).length === 0 && <div className="nc-empty">{t('no-nodes')}</div>}
      {(nodes || []).map((n) => {
        const ti = tunnelInfo(n.tunnel, now);
        const tr = testResult[n.name];
        return (
          <div key={n.name} className="nc-set-node">
            <div className="nc-set-node-head">
              <span className={`nc-dot ${ti.up ? 'on' : ''}`} />
              <b>{n.name}</b>
              <small>{n.ssh} · :{n.localPort}→:{n.remotePort}</small>
              <span className={`nc-set-tunnel${ti.up ? ' up' : ''}`}>
                {t(ti.label)}{ti.since ? ` · ${ti.since}` : ''}
              </span>
            </div>
            <div className="nc-set-node-actions">
              <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => run(n.name, 'test')}>{t('node-test')}</button>
              {ti.up ? (
                <button type="button" className="nc-btn ghost" disabled={!!busy}
                  onClick={() => run(n.name, 'down')}>{t('tunnel-stop')}</button>
              ) : (
                <button type="button" className="nc-btn ghost" disabled={!!busy}
                  onClick={() => run(n.name, 'up')}>{t('tunnel-start')}</button>
              )}
              <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => run(n.name, 'restart')}>{t('tunnel-restart')}</button>
              <button type="button" className="nc-btn danger" disabled={readonly || !!busy}
                title={readonly ? t('settings-readonly') : t('terminate')}
                onClick={() => onRemove(n.name)}><Icon name="trash" size={14} /></button>
            </div>
            {tr && (
              <div className={`nc-set-test${tr.ok ? ' ok' : ' ko'}`}>
                {tr.result}{tr.detail ? ` — ${tr.detail}` : ''}
              </div>
            )}
          </div>
        );
      })}

      <div className="nc-set-form">
        <div className="nc-sheet-label">{t('node-add')}</div>
        <input placeholder={t('node-name-ph')} value={form.name} disabled={readonly}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder={t('node-ssh-ph')} value={form.ssh} disabled={readonly}
          onChange={(e) => setForm({ ...form, ssh: e.target.value })} />
        <input placeholder={t('node-port-ph')} inputMode="numeric" value={form.remotePort} disabled={readonly}
          onChange={(e) => setForm({ ...form, remotePort: e.target.value })} />
        <div className="nc-sheet-actions">
          <button type="button" className="nc-btn primary" disabled={readonly || busy === 'add'}
            title={readonly ? t('settings-readonly') : ''} onClick={onAdd}>{t('add')}</button>
        </div>
      </div>
      <AuthorizedKeysBlock line={akeys} />
      {err && <div className="nc-err">{err}</div>}
    </div>
  );
}

// Notifiche push del MCP bridge (design §3): richiesta permesso + subscribe
// VAPID + persistenza lato server. Stato per-device; in READONLY il subscribe
// e' bloccato dal server (403) e il bottone resta disabilitato con motivo.
function PushRow({ token, readonly }) {
  const [state, setState] = useState('idle'); // unsupported|denied|subscribed|idle
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPushState().then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    setErr(null); setBusy(true);
    try {
      if (state === 'subscribed') { await unsubscribePush(token); setState('idle'); }
      else { await subscribePush(token); setState('subscribed'); }
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === 'push-denied') { setState('denied'); setErr(t('push-denied')); }
      else if (msg === 'push-unsupported') { setState('unsupported'); setErr(t('push-unsupported')); }
      else setErr(msg);
    }
    setBusy(false);
  };

  if (state === 'unsupported') return <div className="nc-set-info">{t('push-unsupported')}</div>;
  return (
    <>
      <div className="nc-set-row">
        <button type="button" className="nc-btn ghost" disabled={readonly || busy || state === 'denied'}
          title={readonly ? t('settings-readonly') : ''} onClick={toggle}>
          {state === 'subscribed' ? t('push-disable') : t('push-enable')}
        </button>
        <span className="nc-set-info">
          {state === 'subscribed' ? t('push-on') : state === 'denied' ? t('push-denied') : t('push-off')}
        </span>
      </div>
      {err && <div className="nc-err">{err}</div>}
    </>
  );
}

// --- scheda SISTEMA ------------------------------------------------------------
function SystemTab({ token, settings, readonly }) {
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState(false);

  const doRotate = async () => {
    setErr(null); setNote(null); setBusy(true);
    try {
      const j = await rotateToken(token);
      setNote(j.note || 'ok');
      setConfirmRotate(false);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const doRegen = async () => {
    setErr(null); setNote(null); setBusy(true);
    try {
      const j = await regenService(token);
      setNote(`${j.note || 'ok'}${j.target ? ` (${j.target})` : ''}`);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const svc = settings && settings.service;
  return (
    <div className="nc-set-tab">
      {settings && (
        <div className="nc-set-info">
          v{settings.version} · {settings.platform} · :{settings.port}
          <br />
          {svc && svc.installed ? t('service-installed') : t('service-missing')}
          {svc && svc.installed ? ` · ${svc.active ? t('service-active') : t('service-inactive')}` : ''}
        </div>
      )}

      <div className="nc-set-row">
        <button type="button" className="nc-btn ghost" disabled={readonly || busy}
          title={readonly ? t('settings-readonly') : ''}
          onClick={() => { setErr(null); setNote(null); setConfirmRotate(true); }}>{t('token-rotate')}</button>
        <button type="button" className="nc-btn ghost" disabled={readonly || busy}
          title={readonly ? t('settings-readonly') : ''} onClick={doRegen}>{t('service-regenerate')}</button>
      </div>

      <PushRow token={token} readonly={readonly} />

      {confirmRotate && (
        <div className="nc-set-confirm">
          <div>{t('token-rotate-explain')}</div>
          <div className="nc-sheet-actions">
            <button type="button" className="nc-btn ghost" disabled={busy}
              onClick={() => setConfirmRotate(false)}>{t('cancel')}</button>
            <button type="button" className="nc-btn primary" disabled={busy}
              onClick={doRotate}>{t('confirm')}</button>
          </div>
        </div>
      )}

      {note && <div className="nc-set-note">{note}</div>}
      {err && <div className="nc-err">{err}</div>}
    </div>
  );
}

export default function SettingsPanel({ token, onClose }) {
  useLang();
  const [tab, setTab] = useState('roles');
  const [settings, setSettings] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [readonly, setReadonly] = useState(false);
  const [loadErr, setLoadErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getSettings(token);
      setSettings(s); setLoadErr(null);
    } catch (e) { setLoadErr(String(e.message || e)); }
    try {
      const j = await getNodes(token);
      setNodes(j.nodes || []);
    } catch (e) { setLoadErr(String(e.message || e)); }
  }, [token]);

  // Poll leggero (5s) finché il pannello è aperto: stato tunnel per-nodo fresco.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Stato READONLY dal server (config effettiva, env inclusa): mutanti disabilitati.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config', token).then((r) => r.json())
      .then((j) => { if (!cancelled) setReadonly(!!j.readonlyDefault); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="nc-set-overlay" onClick={onClose}>
      <div className="nc-set-panel" onClick={(e) => e.stopPropagation()}>
        <div className="nc-set-head">
          <Icon name="gear" size={18} />
          <b>{t('settings')}</b>
          <button type="button" className="nc-set-close" onClick={onClose} title={t('close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {readonly && <div className="nc-set-readonly">{t('settings-readonly')}</div>}
        {loadErr && <div className="nc-err">{loadErr}</div>}

        <div className="nc-set-tabs">
          {['roles', 'nodes', 'fleet', 'system'].map((k) => (
            <button key={k} type="button" className={`nc-set-tabbtn${tab === k ? ' on' : ''}`}
              onClick={() => setTab(k)}>{t(`tab-${k}`)}</button>
          ))}
        </div>

        <div className="nc-set-body">
          {tab === 'roles' && <RolesTab token={token} settings={settings} readonly={readonly} refresh={refresh} />}
          {tab === 'nodes' && <NodesTab token={token} nodes={nodes} readonly={readonly} refresh={refresh} />}
          {tab === 'fleet' && <FleetTab token={token} readonly={readonly} />}
          {tab === 'system' && <SystemTab token={token} settings={settings} readonly={readonly} />}
        </div>
      </div>
    </div>
  );
}
