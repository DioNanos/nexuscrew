// Controller condiviso del pairing "un solo link" (lato ricevente). Logica PURA
// (niente React/DOM) così le decisioni sono testabili in Node: normalizzazione
// input (incolla/QR), classificazione completo-vs-incompleto, corpo della
// richiesta, guard anti doppio submit e resa strutturata degli errori a stadi
// del server. Usato da PairingCard (Settings → Nodi e Wizard/deep-link #pair).
import { decodePairingForm, mergePairingIntoForm } from './settings-model.js';

// QrScanner ritorna una string (API legacy, scanImage default) oppure {data}
// (returnDetailedScanResult: true). Qualunque altra cosa -> ''.
export function normalizeScanResult(res) {
  if (typeof res === 'string') return res.trim();
  if (res && typeof res === 'object' && typeof res.data === 'string') return res.data.trim();
  return '';
}

// Classifica l'input del ricevitore:
//   complete — v2 con ssh+name: basta UN link, si può connettere in automatico.
//   partial  — link valido ma senza routing completo (v1, o v2 monco): servono
//              SOLO i campi elencati in `missing`; il routing SSH non si inventa.
//   invalid  — non è un link di pairing decodificabile.
//   empty    — niente input.
export function classifyPairingInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'empty' };
  const decoded = decodePairingForm(value);
  if (!decoded || !decoded.ok) return { kind: 'invalid' };
  const missing = [];
  if (!decoded.ssh) missing.push('ssh');
  if (!decoded.name) missing.push('name');
  if (!missing.length) return { kind: 'complete', decoded };
  return { kind: 'partial', decoded, missing };
}

// Merge del link decodificato nel form conservando gli edit manuali (`touched`).
// Stessa regola in Settings e Wizard: v2 porta anche name/label quando l'utente
// non li ha toccati. Pura: ritorna un nuovo form.
export function applyDecodedToForm(form, decoded, touched = new Set(), nameEdited = false) {
  if (!decoded || !decoded.ok) return form;
  const merged = mergePairingIntoForm(form, decoded, touched);
  if (decoded.version === 2 && decoded.name && !touched.has('name') && !nameEdited) merged.name = decoded.name;
  if (!touched.has('label') && !merged.label && decoded.label) merged.label = decoded.label;
  return merged;
}

// Resolve a raw value and the form that would be submitted. Both automatic
// sources (paste/QR/deep-link) and a value typed then confirmed with Enter use
// this exact path, so embedded v2 routing is never ignored by manual submit.
export function resolvePairingInput(form, raw, touched = new Set(), nameEdited = false) {
  const value = String(raw || '').trim();
  const classification = classifyPairingInput(value);
  let next = { ...form, pairingUrl: value };
  if (classification.kind === 'complete' || classification.kind === 'partial') {
    next = {
      ...applyDecodedToForm(next, classification.decoded, touched, nameEdited),
      pairingUrl: value,
    };
  }
  return { classification, form: next };
}

// Form -> body di POST /api/settings/nodes/pair. Non fabbrica mai routing: i
// campi assenti restano assenti e il server risponde per stadio (validation).
export function buildPairBody(form, { deviceDefault = '' } = {}) {
  const body = {
    name: form.name, ssh: form.ssh, pairingUrl: form.pairingUrl,
    ...(form.label ? { label: form.label } : {}),
    ...(form.sshPort ? { sshPort: Number(form.sshPort) } : {}),
  };
  const localLabel = form.localLabel || deviceDefault;
  if (localLabel) body.localLabel = localLabel;
  return body;
}

// Guard anti doppio submit: ogni valore di link parte IN AUTOMATICO al massimo
// una volta; mentre una connessione è in corso non ne parte un'altra. Il retry
// manuale resta sempre possibile (reset del valore).
export function createSubmitGuard() {
  const attempted = new Set();
  let busy = false;
  return {
    canAuto(value) { return !busy && !attempted.has(String(value || '')); },
    start(value) {
      if (busy) return false;
      busy = true; attempted.add(String(value || ''));
      return true;
    },
    finish() { busy = false; },
    reset(value) { attempted.delete(String(value || '')); },
    isBusy() { return busy; },
  };
}

// Stadi del contratto backend (lib/settings/routes.js /nodes/pair), in ordine.
export const PAIR_STAGES = ['validation', 'conflict', 'ssh-start', 'ssh-ready', 'join', 'tunnel-final', 'confirm', 'health'];

// Errore jsonFetch -> vista strutturata per la UI: usa e.data (payload JSON del
// server) e degrada al message per i casi legacy/di rete. Mai inghiottire il
// dettaglio in un generico "fetch failed".
export function describePairError(e) {
  const d = (e && e.data) || {};
  const stage = typeof d.stage === 'string' && d.stage ? d.stage : '';
  const detail = typeof d.detail === 'string' && d.detail ? d.detail : '';
  return {
    stage,
    code: typeof d.code === 'string' ? d.code : '',
    detail,
    hint: typeof d.hint === 'string' ? d.hint : '',
    retryable: typeof d.retryable === 'boolean' ? d.retryable : !stage,
    message: detail || String((e && e.message) || e),
  };
}
