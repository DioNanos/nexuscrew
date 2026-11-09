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

// ---------------------------------------------------------------------------
// P3-3 — La card non è più il posto dei dettagli della consegna: il FOGLIO
// della cella la nomina per esteso, con stato, ORA del record e motivo
// leggibile. Il badge quindi ESPONE ts e notReady, che prima perdeva: senza
// quei campi il foglio non potrebbe dire né quando né perché.
// ---------------------------------------------------------------------------
describe('promptDeliveryBadge: espone ora e motivo per il foglio (P3-3)', () => {
  const ts = 1794045762150;

  it('uno skipped porta con sé ts, reason e notReady del record', () => {
    const out = promptDeliveryBadge(cella({
      launchId: 'bc446d765a11e330',
      promptDelivery: {
        state: 'skipped', reason: 'not-ready', notReady: 'busy',
        ts, launchId: 'bc446d765a11e330', generation: 0,
      },
    }));
    expect(out.badge).toBe('problem');
    expect(out.reason).toBe('not-ready');
    expect(out.notReady).toBe('busy');
    expect(out.ts).toBe(ts);
  });

  it('uno submitted porta il ts del record, senza ragioni', () => {
    const out = promptDeliveryBadge(cella({
      promptDelivery: { state: 'submitted', ts, launchId: 'bc446d765a11e330', generation: 1 },
    }));
    expect(out.badge).toBe('submitted');
    expect(out.ts).toBe(ts);
    expect(out.reason).toBeNull();
    expect(out.notReady).toBeNull();
  });

  it('il record di un lancio sostituito non presta la SUA ora al lancio corrente', () => {
    const out = promptDeliveryBadge(
      cella({
        launchId: 'aaaaaaaaaaaaaaaa',
        promptDelivery: { state: 'submitted', ts, launchId: 'bbbbbbbbbbbbbbbb', generation: 1 },
      }),
      { currentLaunchId: 'aaaaaaaaaaaaaaaa' },
    );
    expect(out.badge).toBe('stale');
    expect(out.ts).toBeNull();
  });

  it('senza record non c\'è ora né motivo da mostrare', () => {
    const out = promptDeliveryBadge(cella({}));
    expect(out.badge).toBe('unavailable');
    expect(out.ts).toBeNull();
    expect(out.notReady).toBeNull();
    expect(out.reason).toBeNull();
  });
});

describe('cellRuntime: il terminale di un lancio non è lo stato di una cella viva', () => {
  // Una cella letta dal nodo: terminal {operator-stop, date vecchie}, nessuna
  // attività pubblicata.
  const terminale = { reason: 'operator-stop', ts: 1793633162750 };

  it('con la cella viva il terminale non vince: la riga dice la presenza', () => {
    // La forma vera di /api/sessions: nessuna attività, e `working: false`
    // dichiarato dal contratto della sessione.
    const out = cellRuntime(cella({ terminal: terminale }), { working: false, status: '', attivita: null });
    expect(out.subtitle).toBe(t('cell-present'));
    expect(out.subtitle).not.toBe(`${t('cell-off')} · ${t('cell-terminal-operator-stop')}`);
    expect(out.ncControlLabel).toBeUndefined();
  });

  it('con la cella viva e ferma il terminale non vince: dice «in attesa», non la ragione del lancio vecchio', () => {
    // Stesso terminale, attività `ferma`.
    const out = cellRuntime(cella({ terminal: terminale }), attivita('ferma'));
    expect(out.subtitle).toBe(`${t('cell-present')} · ${t('cell-turn-idle')}`);
    expect(out.subtitle).not.toContain(t('cell-terminal-operator-stop'));
    expect(out.subtitle).not.toBe(t('cell-stopped'));
  });

  // Controllo positivo: a cella NON viva il terminale resta la spiegazione.
  it('con la cella spenta il terminale vince: «spenta · ragione»', () => {
    const out = cellRuntime(cella({ active: false, tmux: false, terminal: terminale }), {});
    expect(out.stato).toBe('ferma');
    expect(out.terminale).toBe('operator-stop');
    expect(out.subtitle).toBe(`${t('cell-off')} · ${t('cell-terminal-operator-stop')}`);
  });
});
