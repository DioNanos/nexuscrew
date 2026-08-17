import { describe, expect, it } from 'vitest';
import { nodeStateLabel } from './roster-view-model.js';
import { t } from './i18n.js';
import { CAUSE_PEER_ASENTE, CAUSE_PEER_NEGA, CAUSE_ROTTA_INESISTENTE } from './peer-backoff.js';

// R21 — tre cause, tre etichette, tre azioni. Il rumore indistinto faceva
// fare la cosa sbagliata; qui si prova che ogni causa produce la SUA frase.
// Le asserzioni confrontano con t(<chiave>), non con testo letterale: il
// contratto e' la mappatura causa -> chiave giusta, in qualunque lingua.
// t() ritorna la CHIAVE nuda quando la traduzione manca: il «not.toBe(key)»
// sotto smaschera anche la chiave senza testo.

describe('nodeStateLabel: peer non raggiungibile per causa (R21)', () => {
  it('peer assente (502/rete) -> peer-cause-assente', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_ASENTE });
    expect(out).toBe(t('peer-cause-assente'));
    expect(out).not.toBe('peer-cause-assente'); // la chiave risolve a testo vero
  });
  it('peer che nega (403) -> peer-cause-nega (azione: concedere il permesso)', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_NEGA });
    expect(out).toBe(t('peer-cause-nega'));
    expect(out).not.toBe('peer-cause-nega');
  });
  it('rotta inesistente (404) -> peer-cause-rotta (azione: aggiornare il nodo)', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_ROTTA_INESISTENTE });
    expect(out).toBe(t('peer-cause-rotta'));
    expect(out).not.toBe('peer-cause-rotta');
  });
  it('tre cause -> tre frasi DISTINTE: mai due cause con la stessa etichetta', () => {
    const a = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_ASENTE });
    const n = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_NEGA });
    const r = nodeStateLabel({ status: 'unreachable', cause: CAUSE_ROTTA_INESISTENTE });
    expect(new Set([a, n, r]).size).toBe(3);
  });
  it('senza causa (dato vecchio o non classificato): l\'etichetta generica di prima, non il silenzio', () => {
    expect(nodeStateLabel({ status: 'unreachable', cause: null })).toBe(t('node-unreachable'));
    expect(nodeStateLabel({ status: 'unreachable' })).toBe(t('node-unreachable'));
  });
});
