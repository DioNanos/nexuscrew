import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { pairNode } from '../lib/api.js';
import { isValidLabel, toSlug } from '../lib/settings-model.js';
import {
  buildPairBody,
  createSubmitGuard, describePairError, resolvePairingInput, PAIR_STAGES,
} from '../lib/pairing-flow.js';
import QrScanModal from './QrScanModal.jsx';
import './PairingCard.css';

const blankForm = () => ({ name: '', label: '', ssh: '', sshPort: '', pairingUrl: '', localLabel: '' });

// Ricevitore "collega con un solo link" — condiviso da Settings → Nodi e dal
// Wizard/deep-link #pair (prima esecuzione), così i due flussi non divergono.
// Percorso normale: incolla (evento o bottone), scansiona il QR o arriva il
// deep-link -> il controller decodifica, precompila e per un payload v2
// COMPLETO chiama pairNode UNA volta sola (guard anti doppio submit), mostra lo
// stato e su successo aggiorna. I campi avanzati (name/label/SSH/porta/etichetta
// locale) restano chiusi di default: si aprono solo per link v1/incompleti (con
// spiegazione precisa di cosa manca — il routing SSH non si inventa mai) o su
// richiesta. Su errore il link e i dati restano nel form: retry sempre possibile
// nel corso della sessione; il deep-link si consuma solo su successo o annulla
// esplicito (responsabilità del genitore via onSuccess/flusso wizard).
export default function PairingCard({ token, initial = '', autoStart = false, deviceDefault = '', readonly = false, onSuccess, onBusyChange }) {
  const [form, setForm] = useState(blankForm);
  const [advanced, setAdvanced] = useState(false);
  const [scan, setScan] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | busy | ok
  const [fail, setFail] = useState(null);     // describePairError()
  const [notice, setNotice] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const guardRef = useRef(createSubmitGuard());
  const touchedRef = useRef(new Set());

  const busy = phase === 'busy';

  useEffect(() => {
    if (onBusyChange) onBusyChange(busy);
    return () => { if (onBusyChange) onBusyChange(false); };
  }, [busy, onBusyChange]);

  const connect = async (f) => {
    const value = String(f.pairingUrl || '').trim();
    if (!guardRef.current.start(value)) return;
    setPhase('busy'); setFail(null); setNotice('');
    try {
      await pairNode(token, buildPairBody(f, { deviceDefault }));
      // Stato locale PRIMA del callback: il genitore può smontare la card.
      setPhase('ok'); setAdvanced(false); setForm(blankForm());
      touchedRef.current = new Set(); setNameEdited(false);
      guardRef.current.finish();
      if (onSuccess) await onSuccess();
    } catch (e) {
      const d = describePairError(e);
      setFail(d); setPhase('idle');
      guardRef.current.finish();
      // Dati mancanti, conflitto o problemi SSH: la correzione sta nei campi
      // avanzati locali. In particolare l'endpoint del link può essere
      // sostituito con l'alias che seleziona chiave/agent su questo dispositivo.
      if (d.stage === 'validation' || d.stage === 'conflict'
        || d.stage === 'ssh-start' || d.stage === 'ssh-ready'
        || String(d.code || '').startsWith('ssh-')) setAdvanced(true);
    }
  };

  // Ingresso condiviso di OGNI sorgente link (paste evento, bottone Incolla, QR,
  // deep-link iniziale): decodifica, precompila e — se il payload è completo e
  // auto è permesso — connette una volta sola.
  const acceptLink = (raw, auto = true) => {
    const { classification: cls, form: next } = resolvePairingInput(
      form, raw, touchedRef.current, nameEdited,
    );
    const value = next.pairingUrl;
    setFail(null); setNotice(''); if (phase === 'ok') setPhase('idle');
    setForm(next);
    if (cls.kind === 'invalid') {
      setFail({ stage: 'validation', code: 'bad-link', message: t('pair-invalid-link'), hint: t('pair-invalid-hint'), retryable: true });
      return;
    }
    if (cls.kind === 'partial') {
      // v1 o v2 monco: compatibile, ma servono SOLO i dati mancanti — spiegati.
      setAdvanced(true);
      setNotice(cls.missing.includes('ssh') ? t('pair-missing-ssh') : t('pair-missing-name'));
      return;
    }
    if (cls.kind === 'complete' && auto && !readonly && guardRef.current.canAuto(value)) connect(next);
  };

  // Deep-link / prefill iniziale: stesso controller, una sola volta.
  useEffect(() => {
    if (initial) acceptLink(initial, autoStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connessione manuale (Enter o bottone): il retry è sempre permesso.
  const manualConnect = () => {
    const value = String(form.pairingUrl || '').trim();
    const { classification: cls, form: next } = resolvePairingInput(
      form, value, touchedRef.current, nameEdited,
    );
    setForm(next);
    setNotice(''); setFail(null);
    if (cls.kind === 'empty') { setFail({ stage: 'validation', message: t('pairing-required'), retryable: true }); return; }
    if (cls.kind === 'invalid') { setFail({ stage: 'validation', code: 'bad-link', message: t('pair-invalid-link'), hint: t('pair-invalid-hint'), retryable: true }); return; }
    if (!next.ssh || !next.name) {
      setAdvanced(true);
      setNotice(!next.ssh ? t('pair-missing-ssh') : t('pair-missing-name'));
      return;
    }
    if (next.label && !isValidLabel(next.label)) { setFail({ stage: 'validation', message: t('err-label'), retryable: true }); return; }
    if (next.localLabel && !isValidLabel(next.localLabel)) { setFail({ stage: 'validation', message: t('err-label'), retryable: true }); return; }
    guardRef.current.reset(value);
    connect(next);
  };

  const pasteFromClipboard = async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') throw new Error('unsupported');
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) acceptLink(text);
      else setNotice(t('pair-clipboard-empty'));
    } catch (_) { setNotice(t('pair-clipboard-denied')); }
  };

  const set = (key, value) => { touchedRef.current.add(key); setForm((f) => ({ ...f, [key]: value })); };
  const stageLabel = fail && fail.stage && (PAIR_STAGES.includes(fail.stage) || fail.stage === 'internal')
    ? t(`pair-stage-${fail.stage}`) : t('pair-stage-generic');

  return (
    <div className="nc-set-form nc-pair-card">
      <div className="nc-sheet-label">{t('pair-card-title')}</div>
      <div className="nc-set-info">{t('pair-card-help')}</div>
      <input
        className="nc-pair-input"
        placeholder={t('pair-paste-ph')}
        value={form.pairingUrl}
        disabled={readonly || busy}
        onChange={(e) => { setForm({ ...form, pairingUrl: e.target.value }); setFail(null); setNotice(''); }}
        onPaste={(e) => {
          const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
          if (text.trim()) { e.preventDefault(); acceptLink(text); }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); manualConnect(); } }}
      />
      <div className="nc-pair-actions">
        <button type="button" className="nc-btn ghost" disabled={readonly || busy} onClick={pasteFromClipboard}>{t('pair-paste-btn')}</button>
        <button type="button" className="nc-btn ghost" disabled={readonly || busy} onClick={() => setScan(true)}>{t('scan-qr')}</button>
        <button type="button" className="nc-btn primary" disabled={readonly || busy}
          title={readonly ? t('settings-readonly') : ''} onClick={manualConnect}>{t('test-and-connect')}</button>
      </div>

      <div className="nc-pair-status" aria-live="polite">
        {busy && <div className="nc-pair-progress">{t('pair-progress')}</div>}
        {phase === 'ok' && <div className="nc-set-test ok">{t('node-connected')}</div>}
        {notice && <div className="nc-set-hint nc-pair-notice">{notice}</div>}
        {fail && (
          <div className="nc-err" role="alert">
            <b>{stageLabel}</b> — {fail.message}
            {fail.hint && <div className="nc-pair-hint">{fail.hint}</div>}
            {fail.retryable && <div><button type="button" className="nc-btn ghost" disabled={readonly || busy} onClick={manualConnect}>{t('pair-retry')}</button></div>}
          </div>
        )}
      </div>

      <button type="button" className="nc-btn ghost nc-pair-advanced-toggle" disabled={busy}
        onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} {t('pair-advanced')}</button>
      {advanced && (
        <div className="nc-pair-advanced">
          <label className="nc-field">{t('node-display-label')}
            <input placeholder="Home Relay" value={form.label} disabled={readonly || busy}
              onChange={(e) => { touchedRef.current.add('label'); setForm((f) => ({ ...f, label: e.target.value, name: nameEdited ? f.name : toSlug(e.target.value) })); }} />
          </label>
          <label className="nc-field">{t('node-name-label')}
            <input placeholder={t('node-name-ph')} value={form.name} disabled={readonly || busy}
              onChange={(e) => { setNameEdited(true); touchedRef.current.add('name'); setForm((f) => ({ ...f, name: e.target.value ? toSlug(e.target.value) : '' })); }} />
          </label>
          <small className="nc-set-hint">{t('node-slug-hint').replace('{slug}', form.name || 'home-relay')}</small>
          <label className="nc-field">{t('pair-ssh-local-label')}
            <input placeholder="my-relay" value={form.ssh} disabled={readonly || busy}
              onChange={(e) => { touchedRef.current.add('ssh'); set('ssh', e.target.value); }} />
            <small className="nc-set-hint">{t('node-ssh-local-help')}</small>
          </label>
          <label className="nc-field">{t('node-ssh-port-label')}
            <input inputMode="numeric" placeholder={t('node-ssh-port-help')} value={form.sshPort} disabled={readonly || busy}
              onChange={(e) => set('sshPort', e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
          </label>
          <label className="nc-field">{t('device-name-label')}
            <input placeholder={deviceDefault || 'NexusCrew'} value={form.localLabel} disabled={readonly || busy}
              onChange={(e) => set('localLabel', e.target.value)} />
            <small className="nc-set-hint">{t('device-name-hint')}</small>
          </label>
        </div>
      )}

      {scan && <QrScanModal onResult={(v) => { setScan(false); acceptLink(v); }} onClose={() => setScan(false)} />}
    </div>
  );
}
