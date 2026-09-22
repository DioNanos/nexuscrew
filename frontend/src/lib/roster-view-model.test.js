import { describe, expect, it } from 'vitest';
import { nodeStateLabel, sessionsAuthoritative, cellRuntime, buildRemoteRoster, buildLocalRoster } from './roster-view-model.js';
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

// ---------------------------------------------------------------------------
// Un gruppo «up» con la lettura delle sessioni caduta non e' una posizione
// verificata: l'inventario delle celle puo' essere completo mentre l'elenco
// tmux e' degradato. Tutto cio' che deriva dalla sessione — attivita',
// anteprima, stato acceso — in quel caso va dichiarato non verificato.
// ---------------------------------------------------------------------------

describe('autorevolezza della lettura: chi puo\' dire cosa', () => {
  const gruppo = (extra = {}) => ({
    name: 'relay', route: ['relay'], status: 'up',
    sessions: [], sessionsAvailable: true, inventoryPartial: false,
    cells: [], unmanaged: [], capabilities: [], engines: [],
    ...extra,
  });

  it('un gruppo up con lettura caduta lo dichiara, invece di tacere', () => {
    expect(sessionsAuthoritative(gruppo())).toBe(true);
    expect(nodeStateLabel(gruppo())).toBe('');

    const parziale = gruppo({ sessionsAvailable: false, inventoryPartial: true });
    expect(sessionsAuthoritative(parziale)).toBe(false);
    expect(nodeStateLabel(parziale)).toBe(t('node-sessions-unverified'));
    // la chiave deve avere un testo: se la traduzione manca, t() torna la
    // chiave nuda e il contratto e' rotto lo stesso
    expect(t('node-sessions-unverified')).not.toBe('node-sessions-unverified');
  });

  it('un nodo giu\' non e\' «non verificato»: e\' un\'altra cosa, e si dice', () => {
    expect(sessionsAuthoritative({ status: 'down' })).toBe(false);
    expect(nodeStateLabel({ status: 'down' })).not.toBe(t('node-sessions-unverified'));
  });

  it('la cella non si dichiara accesa se lo stato della sua sessione non e\' stato letto', () => {
    const cella = { cell: 'Alfa', tmux: true, engine: 'claude', model: 'm1', key: 'k', tmuxSession: 'cloud-Alfa' };
    // lettura autorevole, sessione assente dal campione: il fallback di prima
    const prima = cellRuntime(cella, {});
    expect(prima.unverified).toBeUndefined();
    expect(prima.subtitle).toBeTruthy();

    const dopo = cellRuntime(cella, {}, { autorevole: false });
    expect(dopo.unverified).toBe(true);
    expect(dopo.working).toBe(false);
    expect(dopo.subtitle).toContain(t('cell-unverified'));
    // il motore configurato e' un dato Fleet, che invece c'e': resta visibile
    expect(dopo.subtitle).toContain('claude');
  });

  it('il roster remoto propaga il non verificato alle sue righe', () => {
    const celle = [{ cell: 'Alfa', tmux: true, engine: 'claude', tmuxSession: 'cloud-Alfa' }];
    const verificato = buildRemoteRoster(gruppo({ cells: celle }));
    expect(verificato.rawItems[0].unverified).toBe(false);

    const parziale = buildRemoteRoster(gruppo({ cells: celle, sessionsAvailable: false, inventoryPartial: true }));
    expect(parziale.rawItems[0].unverified).toBe(true);
    expect(parziale.rawItems[0].working).toBe(false);
  });

  it('anche il roster locale accetta di non essere autorevole', () => {
    const celle = [{ cell: 'Alfa', tmux: true, engine: 'claude', tmuxSession: 'cloud-Alfa' }];
    const ok = buildLocalRoster(celle, [], new Map());
    expect(ok[0].unverified).toBe(false);
    const caduto = buildLocalRoster(celle, [], new Map(), undefined, { autorevole: false });
    expect(caduto[0].unverified).toBe(true);
  });
});
