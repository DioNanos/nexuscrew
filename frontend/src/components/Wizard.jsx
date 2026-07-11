import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig, pairNode } from '../lib/api.js';
import './Wizard.css';

// Every installation is always local and may join one Hydra network.
// SSH policy lives in OpenSSH; the PWA only needs a Host alias and a one-time
// pairing link. No roles, key generation, authorized_keys or rendezvous steps.
export default function Wizard({ token, onDone }) {
  useLang();
  const [step, setStep] = useState('welcome');
  const [form, setForm] = useState({ name: '', ssh: '', pairingUrl: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const finish = async () => {
    setBusy(true); setErr(null);
    try { await saveConfig(token, { wizardDone: true }); onDone(); }
    catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };
  const connect = async () => {
    if (!form.name || !form.ssh || !form.pairingUrl) return setErr(t('pairing-required'));
    setBusy(true); setErr(null);
    try { await pairNode(token, form); setStep('done'); }
    catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div className="nc-wiz-overlay"><div className="nc-wiz">
      <div className="nc-wiz-head"><b>{t('wizard-title')}</b><small>{t('hydra-simple')}</small></div>
      {step === 'welcome' && <div className="nc-wiz-body">
        <div className="nc-wiz-done">{t('local-ready')}</div>
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy} onClick={finish}>{t('local-only')}</button>
          <button className="nc-btn primary" disabled={busy} onClick={() => setStep('pair')}>{t('add-node')}</button>
        </div>
      </div>}
      {step === 'pair' && <div className="nc-wiz-body">
        <label className="nc-field">{t('node-name-label')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="relay" /></label>
        <label className="nc-field">{t('node-ssh-label')}<input value={form.ssh} onChange={(e) => setForm({ ...form, ssh: e.target.value })} placeholder="my-relay" /></label>
        <label className="nc-field">{t('pairing-link')}<input value={form.pairingUrl} onChange={(e) => setForm({ ...form, pairingUrl: e.target.value })} placeholder="http://127.0.0.1:…/#pair=…" /></label>
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy} onClick={() => setStep('welcome')}>{t('back')}</button>
          <button className="nc-btn primary" disabled={busy} onClick={connect}>{t('connect')}</button>
        </div>
      </div>}
      {step === 'done' && <div className="nc-wiz-body">
        <div className="nc-wiz-done">{t('node-connected')}</div>
        <div className="nc-sheet-actions"><button className="nc-btn primary" disabled={busy} onClick={finish}>{t('finish')}</button></div>
      </div>}
      {err && <div className="nc-err">{err}</div>}
    </div></div>
  );
}
