import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { saveConfig } from '../lib/api.js';
import PairingCard from './PairingCard.jsx';
import AuthorizedKeysLine from './AuthorizedKeysLine.jsx';
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
export default function Wizard({ token, initialPair, deviceDefault = '', localNodeId = '', localNameDefault = '', deviceNameNeeded = false, deviceNameSuggestion = '', onPairDone, onDone }) {
  useLang();
  const [step, setStep] = useState(initialPair ? 'pair' : 'welcome');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Nome del dispositivo quando l'host non lo dice (Termux/Android): chiesto
  // QUI, al setup, e salvato insieme a wizardDone. Il valore scelto alimenta
  // anche il default locale della PairingCard dello stesso wizard.
  const [deviceName, setDeviceName] = useState(deviceNameSuggestion || '');
  // Questo passo SMONTA la PairingCard: la riga authorized_keys che il pairing
  // ha prodotto va tenuta qui, altrimenti sparisce proprio al primo pairing.
  const [authKeys, setAuthKeys] = useState(null);

  const finish = async () => {
    setBusy(true); setErr(null);
    try {
      const patch = { wizardDone: true };
      if (deviceNameNeeded && deviceName.trim()) patch.deviceName = deviceName.trim();
      await saveConfig(token, patch);
      if (onPairDone) onPairDone(); onDone();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  return (
    <div className="nc-wiz-overlay"><div className="nc-wiz">
      <div className="nc-wiz-head"><b>{t('wizard-title')}</b><small>{t('hydra-simple')}</small></div>
      {step === 'welcome' && <div className="nc-wiz-body">
        <div className="nc-wiz-done">{t('local-ready')}</div>
        {deviceNameNeeded && (
          <div className="nc-wiz-done">{t('wizard-device-name')}</div>
        )}
        {deviceNameNeeded && (
          <label className="nc-field">
            <span>{t('device-name-label')}</span>
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={64}
              data-testid="wizard-device-name-input" />
          </label>
        )}
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy} onClick={finish}>{t('local-only')}</button>
          <button className="nc-btn primary" disabled={busy} onClick={() => setStep('pair')}>{t('add-node')}</button>
        </div>
      </div>}
      {step === 'pair' && <div className="nc-wiz-body">
        <PairingCard token={token} initial={initialPair || ''} autoStart={!!initialPair}
          deviceDefault={deviceNameNeeded && deviceName.trim() ? deviceName.trim() : deviceDefault} localNodeId={localNodeId} localNameDefault={localNameDefault}
          onBusyChange={setBusy}
          onSuccess={async (esito) => {
            setAuthKeys(esito && esito.authorizedKeys
              ? { line: esito.authorizedKeys, note: esito.authorizedKeysNote || '' }
              : null);
            if (onPairDone) onPairDone();
            setStep('done');
          }} />
        <div className="nc-sheet-actions">
          <button className="nc-btn ghost" disabled={busy}
            onClick={() => { if (onPairDone) onPairDone(); setStep('welcome'); }}>{t('back')}</button>
        </div>
      </div>}
      {step === 'done' && <div className="nc-wiz-body">
        <div className="nc-wiz-done">{t('node-connected')}</div>
        {authKeys && <AuthorizedKeysLine line={authKeys.line} note={authKeys.note} />}
        <div className="nc-sheet-actions"><button className="nc-btn primary" disabled={busy} onClick={finish}>{t('finish')}</button></div>
      </div>}
      {err && <div className="nc-err">{err}</div>}
    </div></div>
  );
}
