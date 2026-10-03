import { describe, expect, it } from 'vitest';

// Tetto della vista: il server tiene 9 tile di griglia e, a parte, fino a 6
// flottanti. La vista le tiene insieme nelle columns (flag `float`), quindi
// ogni passaggio che la ripulisce — normalize, e la risoluzione per il viewer
// che il tick di disponibilità applica alla vista corrente — deve contare il
// tetto della griglia sulle sole tile di griglia.
import { fondeFloating, materializeFloating, normalize, stessaVista, stripFloating, MAX_FLOATING } from './grid-model.js';
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

// Merge del poll a tre vie: base = record su cui la vista ha lavorato.
describe('fondeFloating a tre vie', () => {
  const f = (session, x = 0.1) => ({ session, x, y: 0.1, w: 0.3, h: 0.3, fontSize: 11 });
  const nomi = (l) => l.map((x) => x.session).sort();
  it('tolta qui, il remoto la ha ancora: resta tolta', () => {
    expect(fondeFloating([f('a')], [f('a')], [])).toEqual([]);
  });
  it('tolta altrove, qui intatta: resta tolta', () => {
    expect(fondeFloating([f('a')], [], [f('a')])).toEqual([]);
  });
  it('tolta altrove, qui spostata: resta (vince la modifica locale)', () => {
    expect(fondeFloating([f('a')], [], [f('a', 0.4)])).toEqual([f('a', 0.4)]);
  });
  it('aggiunta altrove: entra; aggiunta qui: resta', () => {
    expect(nomi(fondeFloating([], [f('r')], [f('l')]))).toEqual(['l', 'r']);
  });
  it('presente ovunque: vince la geometria locale', () => {
    expect(fondeFloating([f('a')], [f('a', 0.2)], [f('a', 0.3)])).toEqual([f('a', 0.3)]);
  });
  it('se la vista locale non ha mosso la flottante, conserva lo spostamento remoto', () => {
    expect(fondeFloating([f('a', 0.1)], [f('a', 0.2)], [f('a', 0.1)]))
      .toEqual([f('a', 0.2)]);
  });
  it('tetto MAX_FLOATING', () => {
    const tante = Array.from({ length: MAX_FLOATING + 3 }, (_, i) => f(`r${i}`));
    expect(fondeFloating([], tante, [])).toHaveLength(MAX_FLOATING);
  });
});

// Geometria a tre vie PER CAMPO (x, y, w, h, fontSize) per una finestra
// presente ovunque: locale = base → vince il remoto; remoto = base → vince
// il locale; cambiati entrambi → vince il locale (la modifica di chi guarda).
describe('fondeFloating: geometria a tre vie per campo', () => {
  const g = (x, w = 0.3, fontSize = 11) => ({ session: 'a', x, y: 0.1, w, h: 0.3, fontSize });
  it('spostata altrove, qui invariata: vince il remoto', () => {
    expect(fondeFloating([g(0.1)], [g(0.2)], [g(0.1)])).toEqual([g(0.2)]);
  });
  it('spostata qui, altrove invariata: vince il locale', () => {
    expect(fondeFloating([g(0.1)], [g(0.1)], [g(0.3)])).toEqual([g(0.3)]);
  });
  it('campi diversi cambiati dalle due parti: si prendono entrambi', () => {
    expect(fondeFloating([g(0.1, 0.3)], [g(0.2, 0.3)], [g(0.1, 0.4)])).toEqual([g(0.2, 0.4)]);
  });
  it('stesso campo cambiato dalle due parti: vince il locale', () => {
    expect(fondeFloating([g(0.1)], [g(0.2)], [g(0.3)])).toEqual([g(0.3)]);
  });
  it('font cambiato altrove, geometria cambiata qui', () => {
    expect(fondeFloating([g(0.1, 0.3, 11)], [g(0.1, 0.3, 14)], [g(0.2, 0.3, 11)])).toEqual([g(0.2, 0.3, 14)]);
  });
});

describe('stessaVista', () => {
  const v = (fs = 11, x = 0.1) => ({ columns: [{ width: 1, tiles: [
    { session: 'a', height: 1, fontSize: fs },
    { session: 'fl', height: 1, fontSize: 11, float: { x, y: 0.1, w: 0.3, h: 0.3 } },
  ] }] });
  it('ordine delle chiavi diverso: stessa vista', () => {
    const riordinata = { columns: [{ tiles: [
      { fontSize: 11, height: 1, session: 'a' },
      { float: { h: 0.3, w: 0.3, y: 0.1, x: 0.1 }, fontSize: 11, height: 1, session: 'fl' },
    ], width: 1 }] };
    expect(stessaVista(v(), riordinata)).toBe(true);
  });
  it('font o geometria diversi: viste diverse', () => {
    expect(stessaVista(v(), v(12))).toBe(false);
    expect(stessaVista(v(), v(11, 0.2))).toBe(false);
  });
});
