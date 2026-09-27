import { describe, expect, it } from 'vitest';

// Tetto della vista: il server tiene 9 tile di griglia e, a parte, fino a 6
// flottanti. La vista le tiene insieme nelle columns (flag `float`), quindi
// ogni passaggio che la ripulisce — normalize, e la risoluzione per il viewer
// che il tick di disponibilità applica alla vista corrente — deve contare il
// tetto della griglia sulle sole tile di griglia.
import { materializeFloating, normalize, stripFloating, MAX_FLOATING } from './grid-model.js';
import { resolveLayoutForViewer } from './deck-federation.js';

const grigliaPiena = () => ({
  columns: Array.from({ length: 3 }, (_, c) => ({
    width: 1,
    tiles: Array.from({ length: 3 }, (_, r) => ({ session: `cell-${c}-${r}`, height: 1, fontSize: 11 })),
  })),
});
const fl = (session) => ({ session, x: 0.6, y: 0.1, w: 0.3, h: 0.3, fontSize: 11 });
const nomi = (layout) => layout.columns.flatMap((c) => c.tiles.map((t) => t.session));

describe('tetto della vista con griglia piena e flottanti', () => {
  it('normalize tiene 9 di griglia + la flottante', () => {
    const vista = materializeFloating(grigliaPiena(), [fl('fl')]);
    const out = normalize(vista);
    expect(nomi(out)).toHaveLength(10);
    expect(out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'fl').float)
      .toEqual({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 });
  });

  it('la risoluzione per il viewer (tick di disponibilità) non perde la flottante', () => {
    const vista = materializeFloating(grigliaPiena(), [fl('fl')]);
    const out = resolveLayoutForViewer(vista, 'a'.repeat(32), []);
    // tutte e 9 le tile di griglia restano: la flottante non ne scalza una
    expect(nomi(out).sort()).toEqual([...nomi(grigliaPiena()), 'fl'].sort());
    expect(stripFloating(out).floating.map((f) => f.session)).toEqual(['fl']);
  });

  it('normalize taglia comunque la griglia a 9 e le flottanti a MAX_FLOATING', () => {
    const vista = grigliaPiena();
    vista.columns[0].tiles.push({ session: 'decima', height: 1, fontSize: 11 });
    const flott = Array.from({ length: MAX_FLOATING + 2 }, (_, i) => ({
      session: `f${i}`, height: 1, fontSize: 11, float: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    }));
    vista.columns[1].tiles.push(...flott);
    const out = normalize(vista);
    const tiles = out.columns.flatMap((c) => c.tiles);
    expect(tiles.filter((t) => !t.float)).toHaveLength(9);
    expect(tiles.filter((t) => t.float)).toHaveLength(MAX_FLOATING);
    // il taglio segue l'ordine delle colonne, come prima: fuori l'ultima scandita
    expect(nomi(out)).not.toContain('cell-2-2');
  });
});
