import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import {
  apiFetch, getSettings, getPeers, saveConfig, rotateToken,
  removeNode, updateNode, nodeAction, setNodeShare, regenService, createPeerInvite, setNodeVisibility,
  saveNodeAlias, deleteNodeAlias,
  checkNpmUpdate, applyNpmUpdate,
  getDiagnosticsStatus, getDiagnosticsLogs, setDiagnosticsVerbose, clearDiagnosticsLogs,
} from '../lib/api.js';
import { validateNodeForm, tunnelInfo, toSlug, isValidLabel } from '../lib/settings-model.js';
import PairingCard from './PairingCard.jsx';
import { getPushState, subscribePush, unsubscribePush } from '../lib/push.js';
import Icon from './Icon.jsx';
import FleetTab from './FleetTab.jsx';
import { useNodes } from '../hooks/useNodes.js';
import { COMPOSER_RESET_EVENT, clearAllComposerData } from '../lib/composer-model.js';
import './SettingsPanel.css';

// Pannello settings (design §5, B2-UI). Stessa struttura a schede su desktop
// (overlay nel workspace) e mobile (full-screen via CSS). Quattro schede:
//   nodi    — peer Hydra + stato tunnel + azioni
//   fleet   — engine/celle locali o su una route raggiungibile
//   diagnostica — log strutturati bounded locali/routed
//   sistema — token rotate, boot/service e info
// Invarianti UI: token MAI mostrato; ogni failure API mostrata con la causa
// esplicita (jsonFetch propaga j.error); in READONLY i mutanti sono disabilitati
// con motivo visibile (test/up/down/restart restano attivi: non sono gated).

// Bottone copia con feedback per il link di pairing one-time.
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

function PairingQr({ value }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let live = true; QRCode.toDataURL(value, { margin: 1, width: 220 }).then((x) => { if (live) setSrc(x); }).catch(() => {}); return () => { live = false; }; }, [value]);
  return src ? <img src={src} width="220" height="220" alt="NexusCrew pairing QR" /> : null;
}

// --- scheda NODI ---------------------------------------------------------------
function NodesTab({ token, nodes, roster, settings, readonly, refresh, refreshAliases }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);        // `${name}:${action}` in corso
  const [testResult, setTestResult] = useState({}); // name -> {ok, result, detail}
  const [invite, setInvite] = useState(null);
  const [inviteForm, setInviteForm] = useState({ ssh: '', sshPort: '', name: '' });
  const [inviteHubName, setInviteHubName] = useState('');
  const [shareHubName, setShareHubName] = useState('');
  const [devName, setDevName] = useState('');
  const [inviteAdvanced, setInviteAdvanced] = useState(false);
  const [editing, setEditing] = useState(null);
  const [removeConfirm, setRemoveConfirm] = useState(null);
  const now = Date.now();
  const deviceDefault = (settings && settings.deviceName) || '';
  // Un'installazione client invita nella rete a cui è già collegata, non crea
  // un peer diretto verso sé stessa. In questo modo Pixel apre un solo forward
  // verso la porta d'ingresso di VPS3; Mac e gli altri nodi restano route Hydra
  // interne all'hub. I peer inbound non sono hub selezionabili.
  const inviteHubs = (nodes || []).filter((n) => n && n.direction === 'outbound' && n.name && n.ssh);
  const inviteHub = inviteHubs.find((n) => n.name === inviteHubName) || inviteHubs[0] || null;
  const shareHub = inviteHubs.find((n) => n.name === shareHubName) || inviteHubs[0] || null;
  const shareTunnel = shareHub ? tunnelInfo(shareHub.tunnel, now) : null;
  const shareStatusKey = shareHub?.shared
    ? (shareTunnel?.up ? 'share-local-active' : 'share-local-pending')
    : (shareTunnel?.up ? 'share-local-private' : 'share-local-private-down');
  const peerGroups = [
    { key: 'peer-group-hubs', rows: (nodes || []).filter((n) => n.kind !== 'transitive' && n.relation !== 'client') },
    { key: 'peer-group-clients', rows: (nodes || []).filter((n) => n.kind !== 'transitive' && n.relation === 'client') },
    { key: 'peer-group-routed', rows: (nodes || []).filter((n) => n.kind === 'transitive') },
  ];

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
    setErr(null); setBusy(`${name}:remove`);
    try { await removeNode(token, name); setRemoveConfirm(null); await refresh(); }
    catch (e) { setErr(`${name}: ${String(e.message || e)}`); }
    setBusy(null);
  };

  const beginEdit = (node) => setEditing({
    name: node.name,
    direction: node.direction,
    label: node.label || node.name,
    ssh: node.ssh || '',
    sshPort: node.sshPort ? String(node.sshPort) : '',
    autostart: node.autostart === true,
    visibility: node.visibility || 'network',
    selected: [...(node.selected || [])],
  });

  const saveEdit = async () => {
    if (!editing || !isValidLabel(editing.label)) { setErr(t('err-label')); return; }
    const patch = editing.direction === 'inbound'
      ? { label: editing.label, visibility: editing.visibility, selected: editing.visibility === 'selected' ? editing.selected : [] }
      : {
        label: editing.label, ssh: editing.ssh, autostart: editing.autostart,
        ...(editing.sshPort ? { sshPort: Number(editing.sshPort) } : {}),
      };
    setErr(null); setBusy(`${editing.name}:edit`);
    try { await updateNode(token, editing.name, patch); setEditing(null); await refresh(); }
    catch (e) { setErr(`${editing.name}: ${String(e.message || e)}`); }
    setBusy(null);
  };

  const applyShare = async (shared) => {
    if (!shareHub) return;
    setErr(null); setBusy(`${shareHub.name}:share`);
    try { await setNodeShare(token, shareHub.name, shared); await refresh(); }
    catch (e) {
      const hint = e?.data && typeof e.data.hint === 'string' ? e.data.hint : '';
      setErr(`${shareHub.name}: ${String(e.message || e)}${hint ? ` — ${hint}` : ''}`);
    }
    setBusy(null);
  };

  const onCreateInvite = async () => {
    setErr(null);
    if (inviteHub) {
      const checkedHub = validateNodeForm({
        name: inviteHub.name, ssh: inviteHub.ssh, sshPort: inviteHub.sshPort || '',
      });
      if (!checkedHub.ok) { setErr(t(checkedHub.error)); return; }
      setBusy('invite');
      try {
        // Il POST è eseguito sul nodo hub selezionato. Non inoltriamo label/name
        // locali: l'invito deve identificare l'hub, non questo client.
        setInvite(await createPeerInvite(token, {
          ssh: checkedHub.value.ssh,
          ...(checkedHub.value.sshPort ? { sshPort: checkedHub.value.sshPort } : {}),
        }, [inviteHub.name]));
      } catch (e) { setErr(String(e.message || e)); }
      setBusy(null);
      return;
    }
    const name = toSlug(inviteForm.name || devName || deviceDefault || 'NexusCrew');
    const checked = validateNodeForm({ name, ssh: inviteForm.ssh, sshPort: inviteForm.sshPort });
    if (!checked.ok) { setErr(t(checked.error)); return; }
    setBusy('invite');
    try {
      setInvite(await createPeerInvite(token, {
        ...(devName || deviceDefault ? { label: devName || deviceDefault } : {}),
        name,
        ssh: checked.value.ssh,
        ...(checked.value.sshPort ? { sshPort: checked.value.sshPort } : {}),
      }));
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(null);
  };

  return (
    <div className="nc-set-tab">
      <div className="nc-sheet-label">{t('peer-inventory-title')}</div>
      {(nodes || []).length === 0 && <div className="nc-empty">{t('no-nodes')}</div>}
      {peerGroups.map((group) => group.rows.length > 0 && (
        <div className="nc-peer-group" key={group.key}>
          <div className="nc-peer-group-title">{t(group.key)} <span>{group.rows.length}</span></div>
          {group.rows.map((n) => {
            const routed = n.kind === 'transitive';
            const ti = routed
              ? { up: n.stale !== true, label: n.stale === true ? 'peer-routed-stale' : 'peer-routed' }
              : tunnelInfo(n.tunnel, now);
            const tr = testResult[n.name];
            const actions = n.actions || {};
            return (
          <div key={`${n.kind || 'direct'}:${n.nodeId || n.name}`} className={`nc-set-node${routed ? ' routed' : ''}`}>
            <div className="nc-set-node-head">
              <span className={`nc-dot ${ti.up ? 'on' : ''}`} />
              <b>{n.label || n.name}</b>
              <small>
                {n.name}
                {routed ? ` · ${n.route.join(' → ')}` : n.direction === 'outbound' ? ` · SSH ${n.ssh || ''}` : ` · ${t('node-connected-client')}`}
                {n.tunnel?.transport ? ` · ${n.tunnel.transport} ${t('transport-used')}` : ''}
              </small>
              <span className={`nc-set-tunnel${ti.up ? ' up' : ''}`}>
                {t(ti.label)}{ti.since ? ` · ${ti.since}` : ''}
              </span>
            </div>
            {!routed && n.direction === 'inbound' && (
              <div className="nc-set-info">{t(n.shared ? 'peer-shared' : 'peer-private')}</div>
            )}
            {actions.visibility && n.shared && <>
              <select value={n.visibility || 'network'} disabled={readonly || !!busy}
                onChange={async (e) => { setBusy(`${n.name}:visibility`); try { await setNodeVisibility(token, n.name, e.target.value); await refresh(); } catch (x) { setErr(String(x.message || x)); } setBusy(null); }}>
                <option value="network">{t('visibility-network')}</option>
                <option value="relay-only">{t('visibility-relay')}</option>
                <option value="selected">{t('visibility-selected')}</option>
              </select>
              {n.visibility === 'selected' && <div className="nc-set-row">
                {(nodes || []).filter((x) => x.name !== n.name && x.nodeId).map((x) => {
                  const checked = (n.selected || []).includes(x.nodeId);
                  return <label className="nc-check" key={x.nodeId}><input type="checkbox" checked={checked} disabled={readonly || !!busy}
                    onChange={async (e) => { const selected = e.target.checked ? [...(n.selected || []), x.nodeId] : (n.selected || []).filter((id) => id !== x.nodeId); setBusy(`${n.name}:visibility`); try { await setNodeVisibility(token, n.name, 'selected', selected); await refresh(); } catch (z) { setErr(String(z.message || z)); } setBusy(null); }} /> {x.label || x.name}</label>;
                })}
              </div>}
            </>}
            <div className="nc-set-node-actions">
              {actions.edit && <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                onClick={() => beginEdit(n)}>{t('edit')}</button>}
              {actions.test && <button type="button" className="nc-btn ghost" disabled={!!busy}
                onClick={() => run(n.name, 'test')}>{t('node-test')}</button>
              }
              {actions.disconnect && ti.up && (
                <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={() => run(n.name, 'down')}>{t('tunnel-stop')}</button>
              )}
              {actions.connect && !ti.up && (
                <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={() => run(n.name, 'up')}>{t('tunnel-start')}</button>
              )}
              {actions.restart && <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                onClick={() => run(n.name, 'restart')}>{t('tunnel-restart')}</button>
              }
              {actions.remove && <button type="button" className="nc-btn danger" disabled={readonly || !!busy}
                title={readonly ? t('settings-readonly') : t('delete')}
                onClick={() => setRemoveConfirm(n.name)}><Icon name="trash" size={14} /> {t('delete')}</button>}
            </div>
            {editing?.name === n.name && (
              <div className="nc-set-form nc-node-editor">
                <label className="nc-field">{t('node-display-label')}
                  <input value={editing.label} disabled={!!busy}
                    onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
                </label>
                {editing.direction === 'outbound' ? <>
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
                </> : <label className="nc-field">{t('peer-visibility')}
                  <select value={editing.visibility} disabled={!!busy}
                    onChange={(e) => setEditing({ ...editing, visibility: e.target.value })}>
                    <option value="network">{t('visibility-network')}</option>
                    <option value="relay-only">{t('visibility-relay')}</option>
                    <option value="selected">{t('visibility-selected')}</option>
                  </select>
                </label>}
                <div className="nc-set-row">
                  <button type="button" className="nc-btn primary" disabled={!!busy} onClick={saveEdit}>{t('save')}</button>
                  <button type="button" className="nc-btn ghost" disabled={!!busy} onClick={() => setEditing(null)}>{t('cancel')}</button>
                </div>
              </div>
            )}
            {removeConfirm === n.name && (
              <div className="nc-set-confirm">
                <b>{t('node-remove-confirm').replace('{name}', n.label || n.name)}</b>
                <small>{t('node-remove-warning')}</small>
                <div className="nc-set-row">
                  <button type="button" className="nc-btn danger" disabled={!!busy} onClick={() => onRemove(n.name)}>{t('delete')}</button>
                  <button type="button" className="nc-btn ghost" disabled={!!busy} onClick={() => setRemoveConfirm(null)}>{t('cancel')}</button>
                </div>
              </div>
            )}
            {n.health?.detail && <div className={`nc-set-test${n.health.status === 'healthy' ? ' ok' : n.health.status === 'passive' ? '' : ' ko'}`}>{n.health.detail}</div>}
            {tr && (
              <div className={`nc-set-test${tr.ok ? ' ok' : ' ko'}`}>
                {tr.result}{tr.detail ? ` — ${tr.detail}` : ''}
              </div>
            )}
          </div>
            );
          })}
        </div>
      ))}

      {(roster || []).some((g) => !g.direct && g.instanceId) && (
        <div className="nc-set-form">
          <div className="nc-sheet-label">{t('routed-node-aliases')}</div>
          <small className="nc-set-hint">{t('routed-node-aliases-help')}</small>
          {(roster || []).filter((g) => !g.direct && g.instanceId).map((g) => (
            <div key={g.instanceId} className="nc-set-node">
              <div className="nc-set-node-head">
                <span className={`nc-dot ${g.status === 'up' ? 'on' : ''}`} />
                <b>{g.label || g.name}</b>
                <small>{(g.route || []).join(' › ')}</small>
              </div>
              <div className="nc-set-node-actions">
                <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={async () => {
                    const alias = window.prompt(t('node-local-alias'), g.alias || '');
                    if (alias == null) return;
                    if (alias.trim() && !isValidLabel(alias.normalize('NFC'))) { setErr(t('err-label')); return; }
                    setBusy(`${g.instanceId}:alias`); setErr(null);
                    try {
                      if (alias.trim()) await saveNodeAlias(token, g.instanceId, alias);
                      else await deleteNodeAlias(token, g.instanceId);
                      refreshAliases();
                    } catch (e) { setErr(String(e.message || e)); }
                    setBusy(null);
                  }}>{t('alias-on-device')}</button>
                {g.alias && <button type="button" className="nc-btn ghost" disabled={readonly || !!busy}
                  onClick={async () => {
                    setBusy(`${g.instanceId}:alias-reset`); setErr(null);
                    try { await deleteNodeAlias(token, g.instanceId); refreshAliases(); }
                    catch (e) { setErr(String(e.message || e)); }
                    setBusy(null);
                  }}>{t('reset-alias')}</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {shareHub && (
        <div className="nc-set-form nc-local-share">
          <div className="nc-sheet-label">{t('share-local-heading')}</div>
          {inviteHubs.length > 1 && (
            <label className="nc-field">{t('share-local-hub')}
              <select value={shareHub.name} disabled={readonly || !!busy}
                onChange={(e) => setShareHubName(e.target.value)}>
                {inviteHubs.map((hub) => <option key={hub.name} value={hub.name}>{hub.label || hub.name}</option>)}
              </select>
            </label>
          )}
          <label className="nc-check nc-node-share">
            <input type="checkbox" checked={shareHub.shared === true}
              disabled={readonly || !!busy}
              onChange={(e) => applyShare(e.target.checked)} />
            <span>
              <b>{t('share-local-through').replace('{device}', deviceDefault || t('local')).replace('{hub}', shareHub.label || shareHub.name)}</b>
              <small>{t(shareHub.shared ? 'share-node-on-desc' : 'share-node-off-desc')}</small>
            </span>
          </label>
          <div className={`nc-set-test${shareHub.shared && shareTunnel?.up ? ' ok' : !shareTunnel?.up ? ' ko' : ''}`}>
            {t(shareStatusKey)}
          </div>
          {!shareTunnel?.up && <button type="button" className="nc-btn ghost"
            disabled={readonly || !!busy} onClick={() => applyShare(shareHub.shared === true)}>
            {t('share-local-reconnect')}
          </button>}
        </div>
      )}

      {/* Percorso normale del ricevente: UNA card, UN link. I campi avanzati
          (name/label/SSH/porta/etichetta locale) vivono dentro la card, chiusi. */}
      <PairingCard token={token} deviceDefault={deviceDefault}
        localNodeId={(settings && settings.nodeId) || ''}
        localNameDefault={(settings && settings.localName) || ''}
        readonly={readonly} onSuccess={refresh} />

      <div className="nc-set-form">
        <div className="nc-sheet-label">{t('invite-node')}</div>
        <small className="nc-set-hint">{inviteHub ? t('invite-network-hint') : t('invite-v2-hint')}</small>
        {inviteHub ? (
          <>
            {inviteHubs.length > 1 && (
              <label className="nc-field">{t('invite-network-label')}
                <select value={inviteHub.name} disabled={readonly || !!busy}
                  onChange={(e) => { setInviteHubName(e.target.value); setInvite(null); }}>
                  {inviteHubs.map((hub) => <option key={hub.name} value={hub.name}>{hub.label || hub.name}</option>)}
                </select>
              </label>
            )}
            <div className="nc-set-info nc-invite-endpoint">
              {t('invite-network-via')}: <b>{inviteHub.label || inviteHub.name}</b>
              {' · '}{inviteHub.ssh}{inviteHub.sshPort ? `:${inviteHub.sshPort}` : ''}
            </div>
            <small className="nc-set-hint">{t('invite-network-route')}</small>
          </>
        ) : (
          <label className="nc-field">{t('invite-endpoint-label')}
            <input placeholder="user@host" value={inviteForm.ssh} disabled={readonly}
              onChange={(e) => setInviteForm({ ...inviteForm, ssh: e.target.value })} />
            <small className="nc-set-hint">{t('invite-endpoint-needed')}</small>
          </label>
        )}
        {!inviteHub && inviteAdvanced && (
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
          <button type="button" className="nc-btn primary" disabled={readonly || !!busy || (!inviteHub && !inviteForm.ssh.trim())}
            onClick={onCreateInvite}>{t('create-pairing-link')}</button>
          {!inviteHub && <button type="button" className="nc-btn ghost" disabled={!!busy}
            onClick={() => setInviteAdvanced((value) => !value)}>
            {inviteAdvanced ? '▾' : '▸'} {t('pair-advanced')}
          </button>}
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

// --- scheda DIAGNOSTICA -------------------------------------------------------
export function DiagnosticsTab({ token, roster = [], readonly }) {
  const targets = [
    { key: 'local', route: [], label: t('diagnostics-local'), status: 'up' },
    ...roster.filter((group) => Array.isArray(group.route) && group.route.length)
      .map((group) => ({ key: group.route.join('/'), route: group.route, label: group.label || group.name, status: group.status })),
  ];
  const [targetKey, setTargetKey] = useState('local');
  const target = targets.find((item) => item.key === targetKey) || targets[0];
  const [status, setStatus] = useState(null);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [duration, setDuration] = useState(900);
  const [level, setLevel] = useState('all');
  const [component, setComponent] = useState('');
  const cursorRef = useRef(0);
  const logRef = useRef(null);

  const poll = useCallback(async () => {
    try {
      const nextStatus = await getDiagnosticsStatus(token, target.route);
      setStatus(nextStatus); setError('');
      if (!paused) {
        const result = await getDiagnosticsLogs(token, { after: cursorRef.current, limit: 200 }, target.route);
        if (Array.isArray(result.records) && result.records.length) {
          cursorRef.current = result.cursor;
          setRecords((current) => [...current, ...result.records].slice(-500));
        }
      }
    } catch (err) {
      setError(err && err.status === 404 ? t('diagnostics-unsupported') : String(err.message || err));
    }
  }, [token, target.key, paused]);

  useEffect(() => {
    cursorRef.current = 0; setRecords([]); setStatus(null); setError('');
  }, [target.key]);

  useEffect(() => {
    let timer = null; let alive = true;
    const tick = () => {
      if (!alive || document.visibilityState === 'hidden') return;
      poll();
    };
    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = document.visibilityState === 'hidden' ? null : setInterval(tick, 2000);
      if (document.visibilityState !== 'hidden') tick();
    };
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => { alive = false; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [poll]);

  useEffect(() => {
    if (autoscroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [records, autoscroll]);

  const visible = records.filter((entry) => (level === 'all' || entry.level === level)
    && (!component || String(entry.component || '').toLowerCase().includes(component.toLowerCase())));
  const text = visible.map((entry) => `${entry.ts} ${entry.level.toUpperCase()} ${entry.component} ${entry.code} ${entry.message}${Object.keys(entry.meta || {}).length ? ` ${JSON.stringify(entry.meta)}` : ''}`).join('\n');
  const mutate = async (fn) => {
    setError('');
    try { const next = await fn(); setStatus(next); await poll(); }
    catch (err) { setError(String(err.message || err)); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch (_) { setError(t('copy-manual')); }
  };
  const exportLogs = () => {
    try {
      const blob = new Blob([`${JSON.stringify(visible, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'nexuscrew-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
    } catch (_) { setError(t('diagnostics-export-failed')); }
  };

  return (
    <div className="nc-set-tab nc-diagnostics">
      <label className="nc-field">{t('diagnostics-target')}
        <select value={target.key} onChange={(event) => setTargetKey(event.target.value)}>
          {targets.map((item) => <option key={item.key} value={item.key}>{item.label}{item.status !== 'up' ? ` · ${item.status}` : ''}</option>)}
        </select>
      </label>
      <div className="nc-set-form nc-diag-controls">
        <div className="nc-sheet-label">{t('diagnostics-verbose')}</div>
        <div className="nc-set-row">
          <select aria-label={t('diagnostics-duration')} value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={readonly}>
            {[300, 900, 1800, 3600].map((seconds) => <option key={seconds} value={seconds}>{seconds / 60} min</option>)}
          </select>
          <button type="button" className="nc-btn primary" disabled={readonly || status?.verbose === true}
            onClick={() => mutate(() => setDiagnosticsVerbose(token, true, duration, target.route))}>{t('enable')}</button>
          <button type="button" className="nc-btn ghost" disabled={readonly || status?.verbose !== true}
            onClick={() => mutate(() => setDiagnosticsVerbose(token, false, duration, target.route))}>{t('stop')}</button>
        </div>
        <small className="nc-set-hint">{status?.verbose
          ? t('diagnostics-expires').replace('{time}', new Date(status.expiresAt).toLocaleTimeString())
          : t('diagnostics-off')}</small>
      </div>
      <div className="nc-diag-filters">
        <select aria-label={t('diagnostics-level')} value={level} onChange={(event) => setLevel(event.target.value)}>
          <option value="all">{t('diagnostics-all-levels')}</option>
          {['debug', 'info', 'warn', 'error'].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <input aria-label={t('diagnostics-component')} placeholder={t('diagnostics-component')} value={component} onChange={(event) => setComponent(event.target.value)} />
      </div>
      <div className="nc-set-row">
        <label className="nc-check"><input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} /> {t('diagnostics-pause')}</label>
        <label className="nc-check"><input type="checkbox" checked={autoscroll} onChange={(event) => setAutoscroll(event.target.checked)} /> {t('diagnostics-autoscroll')}</label>
      </div>
      <pre ref={logRef} className="nc-diag-log" aria-label={t('diagnostics-log')}>{text || t('diagnostics-empty')}</pre>
      <div className="nc-set-row">
        <button type="button" className="nc-btn ghost" onClick={copy}>{t('copy')}</button>
        <button type="button" className="nc-btn ghost" onClick={exportLogs}>{t('diagnostics-export')}</button>
        <button type="button" className="nc-btn danger" disabled={readonly}
          onClick={() => { if (window.confirm(t('diagnostics-clear-confirm'))) mutate(async () => { const next = await clearDiagnosticsLogs(token, target.route); cursorRef.current = 0; setRecords([]); return next; }); }}>{t('diagnostics-clear')}</button>
      </div>
      {error && <div className="nc-err">{error}</div>}
    </div>
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

  const clearComposerData = () => {
    if (!window.confirm(t('composer-clear-confirm'))) return;
    setErr(null);
    if (clearAllComposerData()) {
      window.dispatchEvent(new Event(COMPOSER_RESET_EVENT));
      setNote(t('composer-clear-done'));
    }
    else setErr(t('composer-clear-failed'));
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

      <div className="nc-set-form">
        <div className="nc-sheet-label">{t('composer-clear-data')}</div>
        <small className="nc-set-hint">{t('composer-clear-data-help')}</small>
        <div className="nc-set-row">
          <button type="button" className="nc-btn ghost" onClick={clearComposerData}>{t('composer-clear-data')}</button>
        </div>
      </div>

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

function CreditsTab() {
  return (
    <div className="nc-set-tab nc-credits">
      <div className="nc-credits-images">
        <img src="/credits/dwarf.png" alt="dwarf" />
        <img src="/credits/knight.png" alt="knight" />
      </div>
      <div className="nc-set-info">{t('credits-attribution')}</div>
      <div className="nc-credits-copy">{t('credits-copyright')}</div>
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
  const [aliasRevision, setAliasRevision] = useState(0);
  const roster = useNodes(token, true, aliasRevision);
  // Credits loop audio lives on the panel (persistent element), started inside
  // the tab-click gesture so mobile autoplay is allowed; paused when leaving
  // the tab or closing the panel.
  const audioRef = useRef(null);
  const selectTab = (k) => {
    setTab(k);
    if (k === 'credits') audioRef.current?.play().catch(() => {});
    else audioRef.current?.pause();
  };

  const refresh = useCallback(async () => {
    try {
      const s = await getSettings(token);
      setSettings(s); setLoadErr(null);
    } catch (e) { setLoadErr(String(e.message || e)); }
    try {
      const j = await getPeers(token);
      setNodes(j.peers || []);
    } catch (e) { setLoadErr(String(e.message || e)); }
  }, [token]);

  // Poll leggero (5s) finché il pannello è aperto: stato tunnel per-nodo fresco.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Closing the panel stops the credits loop.
  useEffect(() => () => audioRef.current?.pause(), []);

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
          {['nodes', 'fleet', 'diagnostics', 'system', 'credits'].map((k) => (
            <button key={k} type="button" className={`nc-set-tabbtn${tab === k ? ' on' : ''}`}
              onClick={() => selectTab(k)}>{t(`tab-${k}`)}</button>
          ))}
        </div>

        <div className="nc-set-body">
          {tab === 'nodes' && <NodesTab token={token} nodes={nodes} roster={roster} settings={settings} readonly={readonly}
            refresh={refresh} refreshAliases={() => setAliasRevision((value) => value + 1)} />}
          {tab === 'fleet' && <FleetTab token={token} readonly={readonly}
            startNewCell={startNewCell} initialLocation={initialLocation}
            targets={roster.map((g) => ({ route: g.route, label: g.label || g.name, status: g.status }))} />}
          {tab === 'diagnostics' && <DiagnosticsTab token={token} roster={roster} readonly={readonly} />}
          {tab === 'system' && <SystemTab token={token} settings={settings} readonly={readonly} refresh={refresh} />}
          {tab === 'credits' && <CreditsTab />}
        </div>
        <audio ref={audioRef} src="/credits/dungeon-loop.mp3" loop preload="auto" />
      </div>
    </div>
  );
}
