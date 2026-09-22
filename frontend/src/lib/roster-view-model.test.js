import { describe, expect, it } from 'vitest';
import { nodeStateLabel, cellRuntime } from './roster-view-model.js';
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

// D-340 — lo stato della cella dagli hook vince sul titolo del pane.
// Il titolo NON prova nulla (rilievo R7: `✳` sta sia su una cella al lavoro sia
// su una ferma), quindi dove non c'e' il canale lo stato e' dichiarato INCERTO
// e non si afferma mai «ferma» da un silenzio.
describe('cellRuntime: tre stati dagli hook + incerto dove il titolo non prova', () => {
  const cella = { tmux: true, cell: 'Dev', engine: 'claude' };
  const att = (stato) => ({ attivita: { stato, ts: Date.now() } });

  it('lavora -> «al lavoro», working true', () => {
    const out = cellRuntime(cella, { ...att('lavora'), working: false });
    expect(out.stato).toBe('lavora');
    expect(out.working).toBe(true);
    expect(out.subtitle).toBe(t('cell-working'));
  });

  it('attesa -> «attesa permesso», resa come lavoro con la sua etichetta', () => {
    const out = cellRuntime(cella, att('attesa'));
    expect(out.stato).toBe('attesa');
    expect(out.working).toBe(true);
    expect(out.subtitle).toBe(t('cell-permission'));
  });

  it('ferma -> «ferma», e NON «in attesa»', () => {
    const out = cellRuntime(cella, att('ferma'));
    expect(out.stato).toBe('ferma');
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(t('cell-stopped'));
    expect(out.subtitle).not.toBe(t('cell-idle'));
  });

  it('lo stato degli hook vince sul titolo: il titolo dice ferma, gli hook dicono lavora', () => {
    const out = cellRuntime(cella, { ...att('lavora'), working: false });
    expect(out.working).toBe(true);
  });

  it('nessun canale: il titolo resta un indizio, dichiarato incerto', () => {
    const out = cellRuntime(cella, { working: true, status: 'Deciphering…' });
    expect(out.working).toBe(true);
    expect(out.stato).toBe('ignoto');
    expect(out.subtitle).toBe(`${t('cell-unknown')} · Deciphering…`);
  });

  it('titolo «non al lavoro» senza canale -> «non verificato», MAI «in attesa»', () => {
    const out = cellRuntime(cella, { working: false });
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(t('cell-unknown'));
    expect(out.subtitle).not.toBe(t('cell-idle'));
  });

  it('peer precedente al contratto (nessun campo working): resta «tmux vivo», che e\' vero', () => {
    const out = cellRuntime(cella, {});
    expect(out.subtitle).toBe(t('cell-on'));
    expect(out.working).toBe(false);
  });

  it('cella spenta: invariata (mostra il motore, o «spenta»)', () => {
    expect(cellRuntime({ tmux: false, cell: 'Dev', engine: 'claude' }, {}).working).toBe(false);
    expect(cellRuntime({ tmux: false, cell: 'Dev', engine: 'claude' }, {}).subtitle).toBe('claude');
    expect(cellRuntime({ tmux: false, cell: 'Dev' }, {}).subtitle).toBe(t('cell-off'));
  });

  it('ogni etichetta nuova risolve a testo vero, in tutte le lingue', () => {
    for (const chiave of ['cell-stopped', 'cell-permission', 'cell-unknown']) {
      expect(t(chiave)).not.toBe(chiave);
    }
    expect(new Set([t('cell-stopped'), t('cell-permission'), t('cell-unknown'), t('cell-idle')]).size).toBe(4);
  });
});
