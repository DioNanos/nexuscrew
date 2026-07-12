import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import {
  apiFetch, getSettings, getNodes, saveConfig, rotateToken,
  removeNode, nodeAction, setNodeRole, regenService, createPeerInvite, setNodeVisibility, renameNodeLabel,
  checkNpmUpdate, applyNpmUpdate,
} from '../lib/api.js';
import { validateNodeForm, validateRendezvousForm, tunnelInfo, toSlug, isValidLabel } from '../lib/settings-model.js';
import PairingCard from './PairingCard.jsx';
import { getPushState, subscribePush, unsubscribePush } from '../lib/push.js';
import Icon from './Icon.jsx';
import FleetTab from './FleetTab.jsx';
import { useNodes } from '../hooks/useNodes.js';
import './SettingsPanel.css';

// Pannello settings (design §5, B2-UI). Stessa struttura a schede su desktop
// (overlay nel workspace) e mobile (full-screen via CSS). Tre schede:
//   nodi    — peer Hydra + stato tunnel + azioni
//   fleet   — engine/celle locali o su una route raggiungibile
//   sistema — token rotate, boot/service e info
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

function PairingQr({ value }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let live = true; QRCode.toDataURL(value, { margin: 1, width: 220 }).then((x) => { if (live) setSrc(x); }).catch(() => {}); return () => { live = false; }; }, [value]);
  return src ? <img src={src} width="220" height="220" alt="NexusCrew pairing QR" /> : null;
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
function NodesTab({ token, nodes, settings, readonly, refresh }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);        // `${name}:${action}` in corso
  const [testResult, setTestResult] = useState({}); // name -> {ok, result, detail}
  const [invite, setInvite] = useState(null);
  const [inviteForm, setInviteForm] = useState({ ssh: '', sshPort: '', name: '' });
  const [devName, setDevName] = useState('');
  const [inviteAdvanced, setInviteAdvanced] = useState(false);
  const now = Date.now();
  const deviceDefault = (settings && settings.deviceName) || '';
  const configuredEndpoint = !!(settings && settings.rendezvous && settings.rendezvous.ssh);

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

  const onCreateInvite = async () => {
    setErr(null);
    const name = toSlug(inviteForm.name || devName || deviceDefault || 'NexusCrew');
    const automaticSsh = settings?.rendezvous?.ssh || '';
    const checked = validateNodeForm({ name, ssh: inviteForm.ssh || automaticSsh, sshPort: inviteForm.sshPort });
    if (!checked.ok) { setErr(t(checked.error)); return; }
    setBusy('invite');
    try {
      setInvite(await createPeerInvite(token, {
        ...(devName || deviceDefault ? { label: devName || deviceDefault } : {}),
        name,
        // Empty means: let the server use its stored rendezvous endpoint. This
        // keeps the normal creator path zero-field and avoids persisting UI
        // guesses. A manually entered target still overrides it.
        ...(inviteForm.ssh.trim() ? { ssh: checked.value.ssh } : {}),
        ...(checked.value.sshPort ? { sshPort: checked.value.sshPort } : {}),
      }));
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(null);
  };

  return (
    <div className="nc-set-tab">
      {/* Percorso normale del ricevente: UNA card, UN link. I campi avanzati
          (name/label/SSH/porta/etichetta locale) vivono dentro la card, chiusi. */}
      <PairingCard token={token} deviceDefault={deviceDefault} readonly={readonly} onSuccess={refresh} />
      {(nodes || []).length === 0 && <div className="nc-empty">{t('no-nodes')}</div>}
      {(nodes || []).map((n) => {
        const ti = tunnelInfo(n.tunnel, now);
        const tr = testResult[n.name];
        return (
          <div key={n.name} className="nc-set-node">
            <div className="nc-set-node-head">
              <span className={`nc-dot ${ti.up ? 'on' : ''}`} />
              <b>{n.label || n.name}</b>
              <small>{n.name} · {n.ssh}{n.sshPort ? `:${n.sshPort}` : ''} · :{n.localPort}→:{n.remotePort}</small>
              <span className={`nc-set-tunnel${ti.up ? ' up' : ''}`}>
                {t(ti.label)}{ti.since ? ` · ${ti.since}` : ''}
              </span>
              <select value={n.visibility || 'network'} disabled={readonly || !!busy}
                onChange={async (e) => { setBusy(`${n.name}:visibility`); try { await setNodeVisibility(token, n.name, e.target.value); await refresh(); } catch (x) { setErr(String(x.message || x)); } setBusy(null); }}>
                <option value="network">{t('visibility-network')}</option>
                <option value="relay-only">{t('visibility-relay')}</option>
                <option value="selected">{t('visibility-selected')}</option>
              </select>
            </div>
            {n.visibility === 'selected' && <div className="nc-set-row">
              {(nodes || []).filter((x) => x.name !== n.name && x.nodeId).map((x) => {
                const checked = (n.selected || []).includes(x.nodeId);
                return <label className="nc-check" key={x.nodeId}><input type="checkbox" checked={checked} disabled={readonly || !!busy}
                  onChange={async (e) => { const selected = e.target.checked ? [...(n.selected || []), x.nodeId] : (n.selected || []).filter((id) => id !== x.nodeId); setBusy(`${n.name}:visibility`); try { await setNodeVisibility(token, n.name, 'selected', selected); await refresh(); } catch (z) { setErr(String(z.message || z)); } setBusy(null); }} /> {x.name}</label>;
              })}
            </div>}
            <div className="nc-set-node-actions">
              <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                onClick={async () => {
                  const label = window.prompt(t('node-display-label'), n.label || n.name);
                  if (label == null) return;
                  if (!isValidLabel(label)) { setErr(t('err-label')); return; }
                  setBusy(`${n.name}:label`);
                  try { await renameNodeLabel(token, n.name, label); await refresh(); } catch (e) { setErr(String(e.message || e)); }
                  setBusy(null);
                }}>{t('edit')}</button>
              {n.health?.managed !== false && <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => run(n.name, 'test')}>{t('node-test')}</button>
              }
              {n.health?.managed !== false && (ti.up ? (
                <button type="button" className="nc-btn ghost" disabled={!!busy}
                  onClick={() => run(n.name, 'down')}>{t('tunnel-stop')}</button>
              ) : (
                <button type="button" className="nc-btn ghost" disabled={!!busy}
                  onClick={() => run(n.name, 'up')}>{t('tunnel-start')}</button>
              ))}
              {n.health?.managed !== false && <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => run(n.name, 'restart')}>{t('tunnel-restart')}</button>
              }
              <button type="button" className="nc-btn danger" disabled={readonly || !!busy}
                title={readonly ? t('settings-readonly') : t('terminate')}
                onClick={() => onRemove(n.name)}><Icon name="trash" size={14} /></button>
            </div>
            {n.health?.detail && <div className={`nc-set-test${n.health.status === 'healthy' ? ' ok' : n.health.status === 'passive' ? '' : ' ko'}`}>{n.health.detail}</div>}
            {tr && (
              <div className={`nc-set-test${tr.ok ? ' ok' : ' ko'}`}>
                {tr.result}{tr.detail ? ` — ${tr.detail}` : ''}
              </div>
            )}
          </div>
        );
      })}

      <div className="nc-set-form">
        <div className="nc-sheet-label">{t('invite-node')}</div>
        <small className="nc-set-hint">{t('invite-v2-hint')}</small>
        {configuredEndpoint && !inviteAdvanced ? (
          <div className="nc-set-info nc-invite-endpoint">
            {t('invite-endpoint-auto')}: <b>{settings.rendezvous.ssh}</b>
            {settings.rendezvous.publishedPort ? ` · Nexus :${settings.rendezvous.publishedPort}` : ''}
          </div>
        ) : (
          <label className="nc-field">{t('invite-endpoint-label')}
            <input placeholder="user@host" value={inviteForm.ssh} disabled={readonly}
              onChange={(e) => setInviteForm({ ...inviteForm, ssh: e.target.value })} />
            <small className="nc-set-hint">{t('invite-endpoint-needed')}</small>
          </label>
        )}
        {inviteAdvanced && (
          <div className="nc-invite-advanced">
            <label className="nc-field">{t('node-ssh-port-label')}
              <input inputMode="numeric" placeholder="22" value={inviteForm.sshPort} disabled={readonly}
                onChange={(e) => setInviteForm({ ...inviteForm, sshPort: e.target.value.replace(/[^0-9]/g, '').slice(0, 5) })} />
            </label>
            <label className="nc-field">{t('device-name-label')}
              <input placeholder={deviceDefault || 'NexusCrew'} value={devName} disabled={readonly}
                onChange={(e) => setDevName(e.target.value)} />
              <small className="nc-set-hint">{t('device-name-hint')}</small>
            </label>
            <label className="nc-field">{t('node-name-label')}
              <input placeholder={toSlug(devName || deviceDefault || t('node-name-ph'))} value={inviteForm.name} disabled={readonly}
                onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value ? toSlug(e.target.value) : '' })} />
            </label>
          </div>
        )}
        <div className="nc-set-row nc-invite-actions">
          <button type="button" className="nc-btn primary" disabled={readonly || !!busy || (!configuredEndpoint && !inviteForm.ssh.trim())}
            onClick={onCreateInvite}>{t('create-pairing-link')}</button>
          <button type="button" className="nc-btn ghost" disabled={!!busy}
            onClick={() => setInviteAdvanced((value) => !value)}>
            {inviteAdvanced ? '▾' : '▸'} {t('pair-advanced')}
          </button>
        </div>
        {invite && <>
          <PairingQr value={invite.pairingUrl} />
          <CopyLine text={invite.pairingUrl} />
          {/* Il link è un contenitore del payload #pair (base 127.0.0.1 del
              creatore): sull'altro dispositivo si INCOLLA/SCANSIONA, non si apre. */}
          <div className="nc-set-info">{t('invite-next-steps')}</div>
        </>}
      </div>
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
function SystemTab({ token, settings, readonly, refresh }) {
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updateView, setUpdateView] = useState(null);
  const [autoUpdate, setAutoUpdate] = useState(true);

  useEffect(() => {
    setUpdateView((settings && settings.update) || null);
    setAutoUpdate(!settings || settings.autoUpdate !== false);
  }, [settings]);

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

  const toggleAutoUpdate = async (enabled) => {
    setErr(null); setNote(null); setBusy(true);
    try {
      await saveConfig(token, { autoUpdate: enabled });
      setAutoUpdate(enabled);
      if (refresh) await refresh();
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const doUpdateCheck = async () => {
    setErr(null); setNote(null); setBusy(true);
    try { setUpdateView(await checkNpmUpdate(token)); }
    catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const doUpdateApply = async () => {
    setErr(null); setNote(null); setBusy(true);
    try {
      const next = await applyNpmUpdate(token);
      setUpdateView(next); setNote(t('npm-update-restarting'));
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
          {svc ? ` · boot ${svc.boot ? 'on' : 'off'}` : ''}
        </div>
      )}

      <div className="nc-set-row">
        <button type="button" className="nc-btn ghost" disabled={readonly || busy}
          title={readonly ? t('settings-readonly') : ''}
          onClick={() => { setErr(null); setNote(null); setConfirmRotate(true); }}>{t('token-rotate')}</button>
        <button type="button" className="nc-btn ghost" disabled={readonly || busy}
          title={readonly ? t('settings-readonly') : ''} onClick={doRegen}>{t('service-regenerate')}</button>
      </div>

      <div className="nc-set-form nc-update-settings">
        <label className="nc-check">
          <input type="checkbox" checked={autoUpdate} disabled={readonly || busy || (updateView && !updateView.supported)}
            onChange={(e) => toggleAutoUpdate(e.target.checked)} />
          <span><b>{t('npm-auto-update')}</b><small>{t('npm-auto-update-help')}</small></span>
        </label>
        {updateView && (
          <div className="nc-set-info">
            {t('npm-update-current')} v{updateView.current}
            {updateView.latest ? ` · ${t('npm-update-latest')} v${updateView.latest}` : ''}
            {' · '}{t(`npm-update-${updateView.supported ? updateView.phase : 'unsupported'}`)}
          </div>
        )}
        <div className="nc-set-row">
          <button type="button" className="nc-btn ghost" disabled={readonly || busy || !updateView || !updateView.supported}
            onClick={doUpdateCheck}>{t('npm-update-check')}</button>
          {updateView && updateView.available && (
            <button type="button" className="nc-btn primary" disabled={readonly || busy || updateView.phase === 'installing'}
              onClick={doUpdateApply}>{t('npm-update-install')}</button>
          )}
        </div>
        {updateView && updateView.lastError && <div className="nc-err">{updateView.lastError}</div>}
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

export default function SettingsPanel({ token, onClose, initialTab = 'nodes', initialLocation = '', startNewCell = false }) {
  useLang();
  const [tab, setTab] = useState(initialTab);
  const [settings, setSettings] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [readonly, setReadonly] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const roster = useNodes(token);

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
          {['nodes', 'fleet', 'system'].map((k) => (
            <button key={k} type="button" className={`nc-set-tabbtn${tab === k ? ' on' : ''}`}
              onClick={() => setTab(k)}>{t(`tab-${k}`)}</button>
          ))}
        </div>

        <div className="nc-set-body">
          {tab === 'nodes' && <NodesTab token={token} nodes={nodes} settings={settings} readonly={readonly} refresh={refresh} />}
          {tab === 'fleet' && <FleetTab token={token} readonly={readonly}
            startNewCell={startNewCell} initialLocation={initialLocation}
            targets={roster.map((g) => ({ route: g.route, label: g.label || g.name, status: g.status }))} />}
          {tab === 'system' && <SystemTab token={token} settings={settings} readonly={readonly} refresh={refresh} />}
        </div>
      </div>
    </div>
  );
}
