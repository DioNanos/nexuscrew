import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig, addNode, setNodeRole } from '../lib/api.js';
import {
  initialWizard, nextStep, prevStep, validateNodeForm, validateRendezvousForm,
} from '../lib/settings-model.js';
import { AuthorizedKeysBlock } from './SettingsPanel.jsx';
import './Wizard.css';

// First-run wizard (design §5, B2-UI): overlay mostrato quando GET /api/settings
// riporta firstRun. Step (macchina a stati in lib/settings-model.js):
//   1. roles       — client/node spiegati in una riga → POST /config {roles}
//   2. node        — opzionale/skippabile: primo nodo remoto → POST /nodes
//                    (mostra la riga authorized_keys da incollare, con copia)
//   3. rendezvous  — SOLO se ruolo node → POST /node-role {enabled:true,...}
//   fine           — POST /config {wizardDone:true} → il wizard non riappare.
// Skippabile in ogni momento ("configura dopo dai settings"): lo skip persiste
// comunque wizardDone. Token MAI mostrato; ogni failure API con causa esplicita.
export default function Wizard({ token, onDone }) {
  useLang();
  const [wiz, setWiz] = useState(initialWizard);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [nodeForm, setNodeForm] = useState({ name: '', ssh: '', remotePort: '' });
  const [nodeAkeys, setNodeAkeys] = useState(null);
  const [rdvForm, setRdvForm] = useState({ ssh: '', publishedPort: '' });
  const [rdvAkeys, setRdvAkeys] = useState(null);

  const { step, roles } = wiz;
  const goNext = () => { setErr(null); setWiz((w) => ({ ...w, step: nextStep(w.step, w.roles) })); };
  const goBack = () => { setErr(null); setWiz((w) => ({ ...w, step: prevStep(w.step, w.roles) })); };

  // Chiusura definitiva: wizardDone persistito (lo skip NON perde il flag: il
  // wizard non deve riapparire a ogni load). Failure = causa mostrata, si resta.
  const finish = async () => {
    setErr(null); setBusy(true);
    try { await saveConfig(token, { wizardDone: true }); onDone(); }
    catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  const submitRoles = async () => {
    setErr(null); setBusy(true);
    try {
      await saveConfig(token, { roles });
      setBusy(false); goNext();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  const submitNode = async () => {
    setErr(null);
    const v = validateNodeForm(nodeForm);
    if (!v.ok) return setErr(t(v.error));
    setBusy(true);
    try {
      const j = await addNode(token, v.value);
      setNodeAkeys(j.authorizedKeys || null); // resta sullo step: l'utente copia la riga
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const submitRendezvous = async () => {
    setErr(null);
    const v = validateRendezvousForm(rdvForm, false);
    if (!v.ok) return setErr(t(v.error));
    setBusy(true);
    try {
      const j = await setNodeRole(token, { enabled: true, ...v.value });
      setRdvAkeys(j.authorizedKeys || null);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const stepTitle = {
    roles: t('wizard-step-roles'),
    node: t('wizard-step-node'),
    rendezvous: t('wizard-step-rendezvous'),
    done: t('wizard-done'),
  }[step];

  return (
    <div className="nc-wiz-overlay">
      <div className="nc-wiz">
        <div className="nc-wiz-head">
          <b>{t('wizard-title')}</b>
          <small>{stepTitle}</small>
        </div>

        {step === 'roles' && (
          <div className="nc-wiz-body">
            <label className="nc-check">
              <input type="checkbox" checked={roles.client}
                onChange={(e) => setWiz((w) => ({ ...w, roles: { ...w.roles, client: e.target.checked } }))} />
              <span><b>{t('role-client')}</b><small>{t('role-client-desc')}</small></span>
            </label>
            <label className="nc-check">
              <input type="checkbox" checked={roles.node}
                onChange={(e) => setWiz((w) => ({ ...w, roles: { ...w.roles, node: e.target.checked } }))} />
              <span><b>{t('role-node')}</b><small>{t('role-node-desc')}</small></span>
            </label>
            <div className="nc-sheet-actions">
              <button type="button" className="nc-btn primary" disabled={busy} onClick={submitRoles}>{t('next')}</button>
            </div>
          </div>
        )}

        {step === 'node' && (
          <div className="nc-wiz-body">
            <input placeholder={t('node-name-ph')} value={nodeForm.name}
              onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })} />
            <input placeholder={t('node-ssh-ph')} value={nodeForm.ssh}
              onChange={(e) => setNodeForm({ ...nodeForm, ssh: e.target.value })} />
            <input placeholder={t('node-port-ph')} inputMode="numeric" value={nodeForm.remotePort}
              onChange={(e) => setNodeForm({ ...nodeForm, remotePort: e.target.value })} />
            <AuthorizedKeysBlock line={nodeAkeys} />
            <div className="nc-sheet-actions">
              <button type="button" className="nc-btn ghost" disabled={busy} onClick={goBack}>{t('back')}</button>
              {!nodeAkeys && (
                <button type="button" className="nc-btn ghost" disabled={busy} onClick={goNext}>{t('skip')}</button>
              )}
              {!nodeAkeys && (
                <button type="button" className="nc-btn primary" disabled={busy} onClick={submitNode}>{t('add')}</button>
              )}
              {nodeAkeys && (
                <button type="button" className="nc-btn primary" disabled={busy} onClick={goNext}>{t('next')}</button>
              )}
            </div>
          </div>
        )}

        {step === 'rendezvous' && (
          <div className="nc-wiz-body">
            <input placeholder={t('rendezvous-ssh')} value={rdvForm.ssh}
              onChange={(e) => setRdvForm({ ...rdvForm, ssh: e.target.value })} />
            <input placeholder={t('published-port')} inputMode="numeric" value={rdvForm.publishedPort}
              onChange={(e) => setRdvForm({ ...rdvForm, publishedPort: e.target.value })} />
            <AuthorizedKeysBlock line={rdvAkeys} />
            <div className="nc-sheet-actions">
              <button type="button" className="nc-btn ghost" disabled={busy} onClick={goBack}>{t('back')}</button>
              {!rdvAkeys && (
                <button type="button" className="nc-btn ghost" disabled={busy} onClick={goNext}>{t('skip')}</button>
              )}
              {!rdvAkeys && (
                <button type="button" className="nc-btn primary" disabled={busy} onClick={submitRendezvous}>{t('enable')}</button>
              )}
              {rdvAkeys && (
                <button type="button" className="nc-btn primary" disabled={busy} onClick={goNext}>{t('next')}</button>
              )}
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="nc-wiz-body">
            <div className="nc-wiz-done">{t('wizard-done-desc')}</div>
            <div className="nc-sheet-actions">
              <button type="button" className="nc-btn ghost" disabled={busy} onClick={goBack}>{t('back')}</button>
              <button type="button" className="nc-btn primary" disabled={busy} onClick={finish}>{t('finish')}</button>
            </div>
          </div>
        )}

        {err && <div className="nc-err">{err}</div>}

        {step !== 'done' && (
          <button type="button" className="nc-wiz-skip" disabled={busy} onClick={finish}>
            {t('wizard-skip')}
          </button>
        )}
      </div>
    </div>
  );
}
