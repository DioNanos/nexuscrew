import { describe, expect, it } from 'vitest';
import {
  cellScopeMode, cellScopeGrants, cellScopeCandidates, nodeDetailModel,
} from './node-detail.js';

// Lo scope celle in UI (NC-I). Il permesso esisteva gia' lato server ed era
// impostabile solo da riga di comando: chi amministra dalla PWA non poteva
// restringere un nodo, che e' il caso d'uso per cui il permesso e' nato.
//
// Il modello e' il gemello di selectionGrants/selectionCandidates e ne ripete
// deliberatamente le regole — un elenco di CONCESSIONI, non l'universo con le
// spunte; un permesso concesso a qualcosa che non esiste piu' resta visibile.

const peer = (extra = {}) => ({
  name: 'pixel', nodeId: 'b'.repeat(32), kind: 'direct', shared: true,
  actions: { edit: true, visibility: true }, ...extra,
});
const CELLS = [{ cell: 'Dev' }, { cell: 'Research' }, { cell: 'Trading' }];

describe('cellScopeMode', () => {
  it('senza campo vale "all": e\' il default anche lato server', () => {
    expect(cellScopeMode(peer())).toBe('all');
    expect(cellScopeMode(null)).toBe('all');
  });

  it('un valore che non conosce non diventa un permesso', () => {
    // Fail-closed sul VOCABOLARIO: un modo inatteso ricade sul default noto
    // invece di essere passato avanti come se fosse valido.
    expect(cellScopeMode(peer({ cellVisibility: 'quasi-tutte' }))).toBe('all');
  });

  it('riconosce i tre modi veri', () => {
    for (const mode of ['all', 'none', 'selected']) {
      expect(cellScopeMode(peer({ cellVisibility: mode }))).toBe(mode);
    }
  });
});

describe('cellScopeGrants', () => {
  it('elenca solo in modalita\' selected', () => {
    expect(cellScopeGrants(peer({ cellVisibility: 'all', cells: ['Dev'] }), CELLS)).toEqual([]);
    expect(cellScopeGrants(peer({ cellVisibility: 'none', cells: ['Dev'] }), CELLS)).toEqual([]);
  });

  it('una cella concessa che non esiste piu\' resta, marcata come sconosciuta', () => {
    // Sparire in silenzio nasconderebbe un permesso ancora attivo sul server:
    // l'operatore crederebbe di aver tolto qualcosa che invece regge.
    const out = cellScopeGrants(peer({ cellVisibility: 'selected', cells: ['Research', 'Sparita'] }), CELLS);
    expect(out.map((g) => [g.id, g.known])).toEqual([['Research', true], ['Sparita', false]]);
  });

  it('lo stesso nome due volte e\' una concessione sola', () => {
    // Mostrarlo due volte farebbe credere a due permessi distinti, uno dei
    // quali sembrerebbe non togliersi mai.
    const out = cellScopeGrants(peer({ cellVisibility: 'selected', cells: ['Dev', 'Dev'] }), CELLS);
    expect(out).toHaveLength(1);
  });

  it('mentre l\'elenco non e\' ancora arrivato, nessuna concessione e\' "sconosciuta"', () => {
    // «Non lo so» non deve leggersi come «non esiste piu'»: un foglio appena
    // aperto marcherebbe tutte le concessioni come morte per il tempo di una
    // richiesta di rete.
    const node = peer({ cellVisibility: 'selected', cells: ['Dev', 'Sparita'] });
    expect(cellScopeGrants(node, null).every((g) => g.known)).toBe(true);
    expect(cellScopeGrants(node, undefined).every((g) => g.known)).toBe(true);
    // Un elenco VUOTO invece e' un'informazione: nessuna cella esiste.
    expect(cellScopeGrants(node, []).some((g) => g.known)).toBe(false);
  });

  it('regge un elenco di celle in forma di stringhe', () => {
    const out = cellScopeGrants(peer({ cellVisibility: 'selected', cells: ['Dev'] }), ['Dev', 'Research']);
    expect(out[0].known).toBe(true);
  });
});

describe('cellScopeCandidates', () => {
  it('offre solo cio\' che non e\' gia\' concesso, in ordine', () => {
    const out = cellScopeCandidates(peer({ cellVisibility: 'selected', cells: ['Research'] }), CELLS);
    expect(out.map((c) => c.id)).toEqual(['Dev', 'Trading']);
  });

  it('la ricerca non distingue maiuscole', () => {
    const out = cellScopeCandidates(peer({ cells: [] }), CELLS, 'reSE');
    expect(out.map((c) => c.id)).toEqual(['Research']);
  });

  it('senza celle note non inventa candidati', () => {
    expect(cellScopeCandidates(peer(), [])).toEqual([]);
    expect(cellScopeCandidates(peer(), null)).toEqual([]);
  });
});

describe('nodeDetailModel — chi puo\' impostare lo scope', () => {
  it('un peer diretto NON condiviso resta configurabile', () => {
    // Differenza deliberata dalla visibilita' di transito, che richiede
    // `shared`: lo scope celle e' un permesso di lettura sulle NOSTRE celle, e
    // un nodo privato e' proprio quello che si vuole restringere per primo.
    const model = nodeDetailModel(peer({ shared: false }), []);
    expect(model.canEditCellScope).toBe(true);
    expect(model.canEditVisibility).toBe(false);
  });

  it('un nodo raggiunto in transito non e\' nostro da restringere', () => {
    const model = nodeDetailModel(peer({ kind: 'transitive', route: ['hub', 'altro'] }), []);
    expect(model.canEditCellScope).toBe(false);
  });

  it('senza il permesso di modifica dal server, niente controllo', () => {
    const model = nodeDetailModel(peer({ actions: { visibility: true } }), []);
    expect(model.canEditCellScope).toBe(false);
  });

  it('il modo corrente arriva al foglio senza che il componente lo ricalcoli', () => {
    const model = nodeDetailModel(peer({ cellVisibility: 'selected', cells: ['Dev'] }), []);
    expect(model.cellScope).toBe('selected');
  });
});
