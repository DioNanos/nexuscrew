import { describe, expect, it } from 'vitest';
import { cellRuntime, promptDeliveryBadge } from './roster-view-model.js';
import { t } from './i18n.js';

// The fixtures are the values the node answered on 2026-11-07 around 11:04,
// cell by cell (GET /api/fleet/status and GET /api/sessions): every cell was
// `active: true` with a live tmux session, and the labels said otherwise.
//
// The contract asserted here is about MEANING, not about a style:
//
//   - `promptDelivery.state === 'unknown'` means "it cannot be attested", not
//     "it failed": it gets a neutral word of its own, and the failure word
//     stays for a refusal that is proven;
//   - a terminal record is the outcome of a LAUNCH: while the cell is alive it
//     does not overwrite the row, and when the cell is not alive it does.
//
// Assertions compare with `t(<key>)`, never with a literal: the contract is the
// mapping, in every language. `t()` returns the bare key when a translation is
// missing, so `not.toBe(key)` also catches a key with no text.

const ATTIVA = { active: true, tmux: true };

function cella(extra = {}) {
  return { ...ATTIVA, cell: 'cella-a', engine: 'claude.native', ...extra };
}

function attivita(stato) {
  return { attivita: { stato, ts: 1794045762150, sessionId: 's', generazione: 'g' } };
}

describe('promptDeliveryBadge: unknown non è un fallimento', () => {
  // Quattro celle lette dal nodo: {state: "unknown", launchId: "..."},
  // senza generation — il backend dice «non attestabile».
  const unknown = { state: 'unknown', launchId: 'bc446d765a11e330' };

  it('unknown -> badge neutro proprio, non «problem»', () => {
    const out = promptDeliveryBadge(cella({ promptDelivery: unknown }));
    expect(out.badge).toBe('unverified');
    expect(out.badge).not.toBe('problem');
  });

  it('unknown -> la sua parola, e non quella del fallimento', () => {
    const out = promptDeliveryBadge(cella({ promptDelivery: unknown }));
    expect(out.key).toBe('prompt-badge-unverified');
    expect(t(out.key)).toBe(t('prompt-badge-unverified'));
    expect(t(out.key)).not.toBe('prompt-badge-unverified'); // la chiave ha un testo
    expect(t(out.key)).not.toBe(t('prompt-badge-problem'));
  });

  it('unknown resta «non attestato» anche da una lettura non corrente', () => {
    const out = promptDeliveryBadge(cella({ promptDelivery: unknown }), { autorevole: false });
    expect(out.key).toBe('prompt-badge-unverified');
    expect(out.freschezza).toBe('last-known');
  });

  // Il controllo positivo: un fallimento ATTESTATO resta un fallimento.
  it('uno skip con una ragione di rifiuto resta «problem»', () => {
    const out = promptDeliveryBadge(cella({
      promptDelivery: { state: 'skipped', reason: 'transport-unsupported', launchId: 'x1' },
    }));
    expect(out.badge).toBe('problem');
    expect(out.key).toBe('prompt-badge-problem');
  });

  it('senza alcun record il badge resta «unavailable»', () => {
    const out = promptDeliveryBadge(cella({ promptDelivery: null }));
    expect(out.badge).toBe('unavailable');
    expect(out.key).toBe('prompt-badge-unavailable');
  });
});

describe('cellRuntime: il terminale di un lancio non è lo stato di una cella viva', () => {
  // Una cella letta dal nodo: terminal {operator-stop, date vecchie}, nessuna
  // attività pubblicata.
  const terminale = { reason: 'operator-stop', ts: 1793633162750 };

  it('con la cella viva il terminale non vince: decide l’attività (assente -> unverified)', () => {
    // La forma vera di /api/sessions: nessuna attività, e `working: false`
    // dichiarato dal contratto della sessione.
    const out = cellRuntime(cella({ terminal: terminale }), { working: false, status: '', attivita: null });
    expect(out.subtitle).toBe(t('cell-unknown'));
    expect(out.subtitle).not.toBe(t('cell-terminal-operator-stop'));
  });

  it('con la cella viva e ferma il terminale non vince: dice «stopped», non «stopped by operator»', () => {
    // Stesso terminale, attività `ferma`.
    const out = cellRuntime(cella({ terminal: terminale }), attivita('ferma'));
    expect(out.subtitle).toBe(t('cell-stopped'));
    expect(out.subtitle).not.toBe(t('cell-terminal-operator-stop'));
  });

  // Controllo positivo: a cella NON viva il terminale resta la spiegazione.
  it('con la cella spenta il terminale vince, come prima', () => {
    const out = cellRuntime(cella({ active: false, tmux: false, terminal: terminale }), {});
    expect(out.stato).toBe('ferma');
    expect(out.terminale).toBe('operator-stop');
    expect(out.subtitle).toBe(t('cell-terminal-operator-stop'));
  });
});
