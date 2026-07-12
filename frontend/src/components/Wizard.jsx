import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig } from '../lib/api.js';
import PairingCard from './PairingCard.jsx';
import './Wizard.css';

// Every installation is always local and may join one Hydra network.
// SSH policy lives in OpenSSH; the PWA only needs a Host alias and a one-time
// pairing link. No roles, key generation, authorized_keys or rendezvous steps.
//
// initialPair: payload #pair arrivato dalla address bar (deep-link). Se
// presente, il wizard salta al passo di pairing e la STESSA PairingCard di
// Impostazioni → Nodi (nessuna deriva tra i due flussi) decodifica il link e —
// se è un v2 completo — si collega da sola (autoStart). L'invite one-time si
// "consuma" (onPairDone pulisce il fragment dal sessionStorage) SOLO a
// connessione avvenuta o su annulla esplicito: un tentativo fallito resta
// riprovabile per tutta la sessione del tab.
export default function Wizard({ token, initialPair, onPairDone, onDone }) {
  useLang();
  const [step, setStep] = useState(initialPair ? 'pair' : 'welcome');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const finish = async () => {
    setBusy(true); setErr(null);
    try { await saveConfig(token, { wizardDone: true }); if (onPairDone) onPairDone(); onDone(); }
    catch (e) { setErr(String(e.message || e)); setBusy(false); }
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
        <PairingCard token={token} initial={initialPair || ''} autoStart={!!initialPair}
          onBusyChange={setBusy}
          onSuccess={async () => { if (onPairDone) onPairDone(); setStep('done'); }} />
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy}
            onClick={() => { if (onPairDone) onPairDone(); setStep('welcome'); }}>{t('back')}</button>
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
