import { useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig, pairNode } from '../lib/api.js';
import { toSlug, isValidLabel, decodePairingForm, mergePairingIntoForm } from '../lib/settings-model.js';
import './Wizard.css';

// Every installation is always local and may join one Hydra network.
// SSH policy lives in OpenSSH; the PWA only needs a Host alias and a one-time
// pairing link. No roles, key generation, authorized_keys or rendezvous steps.
//
// initialPair: payload #pair arrivato dalla address bar (deep-link). Se presente,
// il wizard apre direttamente lo step di pairing con il link precompilato e lo
// "consuma" (onPairDone pulisce il fragment dal sessionStorage) a connessione
// avvenuta o se l'utente annulla — l'invite è one-time e sensibile.
// Un solo link basta: la STESSA funzione pura di Settings decodifica v1/v2 e
// precompila label/slug/ssh/sshPort (v2) anche dal deep-link iniziale.
export default function Wizard({ token, initialPair, onPairDone, onDone }) {
  useLang();
  const [step, setStep] = useState(initialPair ? 'pair' : 'welcome');
  const [form, setForm] = useState(() => {
    const base = { name: '', label: '', ssh: '', sshPort: '', pairingUrl: initialPair || '', localLabel: '' };
    if (!initialPair) return base;
    const decoded = decodePairingForm(initialPair);
    return decoded && decoded.ok ? { ...mergePairingIntoForm(base, decoded, new Set()), pairingUrl: initialPair } : base;
  });
  const touchedRef = useRef(new Set());
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const finish = async () => {
    setBusy(true); setErr(null);
    try { await saveConfig(token, { wizardDone: true }); if (onPairDone) onPairDone(); onDone(); }
    catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };
  const onLabel = (v) => { touchedRef.current.add('label'); setForm((f) => ({ ...f, label: v, name: nameEdited ? f.name : toSlug(v) })); };
  const onName = (v) => { touchedRef.current.add('name'); setNameEdited(true); setForm((f) => ({ ...f, name: v ? toSlug(v) : '' })); };
  const onSsh = (v) => { touchedRef.current.add('ssh'); setForm((f) => ({ ...f, ssh: v })); };
  const applyPairing = (url) => {
    setForm((f) => {
      const decoded = decodePairingForm(url);
      if (!decoded || !decoded.ok) return { ...f, pairingUrl: url };
      const merged = mergePairingIntoForm(f, decoded, touchedRef.current);
      if (decoded.version === 2 && decoded.name && !touchedRef.current.has('name') && !nameEdited) merged.name = decoded.name;
      return { ...merged, pairingUrl: url };
    });
  };
  const connect = async () => {
    if (!form.name || !form.ssh || !form.pairingUrl) return setErr(t('pairing-required'));
    if (form.label && !isValidLabel(form.label)) return setErr(t('err-label'));
    if (form.localLabel && !isValidLabel(form.localLabel)) return setErr(t('err-label'));
    setBusy(true); setErr(null);
    try {
      // /nodes/pair = "testa e collega": provisional + join + confirm + rollback.
      await pairNode(token, {
        name: form.name, ssh: form.ssh, pairingUrl: form.pairingUrl,
        ...(form.label ? { label: form.label } : {}),
        ...(form.sshPort ? { sshPort: Number(form.sshPort) } : {}),
        localLabel: form.localLabel || undefined,
      });
      if (onPairDone) onPairDone();
      setStep('done');
    } catch (e) { setErr(String(e.message || e)); }
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
        <label className="nc-field">{t('node-display-label')}<input value={form.label} onChange={(e) => onLabel(e.target.value)} placeholder="Home Relay" /></label>
        <label className="nc-field">{t('node-name-label')}<input value={form.name} onChange={(e) => onName(e.target.value)} placeholder={t('node-name-ph')} /></label>
        <label className="nc-field">{t('node-ssh-label')}<input value={form.ssh} onChange={(e) => onSsh(e.target.value)} placeholder="my-relay" /></label>
        <label className="nc-field">{t('device-name-label')}<input value={form.localLabel} onChange={(e) => setForm({ ...form, localLabel: e.target.value })} placeholder="NexusCrew" /><small className="nc-set-hint">{t('device-name-hint')}</small></label>
        <label className="nc-field">{t('pairing-link')}<input value={form.pairingUrl} onChange={(e) => applyPairing(e.target.value)} placeholder="http://127.0.0.1:…/#pair=…" /><small className="nc-set-hint">{t('pairing-v2-hint')}</small></label>
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy} onClick={() => { if (onPairDone) onPairDone(); setStep('welcome'); }}>{t('back')}</button>
          <button className="nc-btn primary" disabled={busy} onClick={connect}>{t('test-and-connect')}</button>
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
