import { describe, expect, it } from 'vitest';
// Finestre flottanti — la VISTA tiene le finestre staccate nelle columns con un
// flag `float` (geometria in frazioni di schermo): così il GridTile resta
// alla stessa posizione dell'albero e non si smonta mai. La
// SERIALIZZAZZIONE (record del deck) le sposta fuori: griglia pura + lista
// `floating` a livello record. Materializzazione = load.
import {
  detachTile, reattachTile, updateFloatGeom, floatingRefs, stripFloating, materializeFloating,
  addTileSmart, normalize,
} from './grid-model.js';

const vista = () => ({
  columns: [
    { width: 1, tiles: [
      { session: 'a', height: 1, fontSize: 11, float: { x: 0.5, y: 0.2, w: 0.4, h: 0.5 } },
      { session: 'b', height: 1, fontSize: 11 },
    ] },
    { width: 1, tiles: [{ session: 'c', height: 1, fontSize: 11 }] },
  ],
});

describe('detachTile / reattachTile / updateFloatGeom', () => {
  it('detach mette il flag float clampato dentro lo schermo', () => {
    const out = detachTile(vista(), 'b', { x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    const b = out.columns[0].tiles[1];
    expect(b.float).toEqual({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
    expect(out.columns[0].tiles[0].float).toEqual({ x: 0.5, y: 0.2, w: 0.4, h: 0.5 });
  });

  it('oltre il tetto di 6 flottanti il detach non fa nulla (stesso riferimento)', () => {
    const l = { columns: [{ width: 1, tiles: Array.from({ length: 7 }, (_v, i) => ({ session: `s${i}`, height: 1, fontSize: 11 })) }] };
    let cur = l;
    for (let i = 0; i < 6; i += 1) cur = detachTile(cur, `s${i}`, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    const settimo = detachTile(cur, 's6', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(settimo).toBe(cur);
    expect(floatingRefs(settimo)).toHaveLength(6);
  });

  it('reattach toglie il flag; updateFloatGeom aggiorna solo quello', () => {
    const staccata = detachTile(vista(), 'b', { x: 0.1, y: 0.1, w: 0.3, h: 0.3 });
    const mossa = updateFloatGeom(staccata, 'b', { x: 0.2, y: 0.2, w: 0.3, h: 0.3 });
    expect(mossa.columns[0].tiles[1].float.x).toBe(0.2);
    const riattaccata = reattachTile(mossa, 'b');
    expect(riattaccata.columns[0].tiles[1].float).toBeUndefined();
    expect(riattaccata.columns[0].tiles[0].float).toBeDefined();
  });
});

describe('stripFloating / materializeFloating — record e ritorno', () => {
  it('strip: griglia senza flottanti, colonne svuotate rimosse, record con i soli campi del server', () => {
    const { grid, floating } = stripFloating(vista());
    expect(grid.columns).toHaveLength(2);
    expect(grid.columns[0].tiles.map((t) => t.session)).toEqual(['b']);
    expect(floating).toEqual([{ session: 'a', x: 0.5, y: 0.2, w: 0.4, h: 0.5, fontSize: 11 }]);
  });

  it('colonna svuotata del tutto SPARISCE dalla griglia serializzata', () => {
    const l = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1, fontSize: 11, float: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }] }] };
    const { grid, floating } = stripFloating(l);
    expect(grid.columns).toHaveLength(0);
    expect(floating).toHaveLength(1);
  });

  it('materialize: flottante reinserito (colonna meno piena) con flag; round-trip stabile', () => {
    const { grid, floating } = stripFloating(vista());
    const again = materializeFloating(grid, floating);
    expect(floatingRefs(again)).toEqual(['a']);
    const a = again.columns.flatMap((c) => c.tiles).find((t) => t.session === 'a');
    expect(a.float).toEqual({ x: 0.5, y: 0.2, w: 0.4, h: 0.5 });
    // round-trip: strip(materialize(strip(v))) == strip(v)
    const due = stripFloating(again);
    expect(due.floating).toEqual(floating);
    expect(due.grid.columns.map((c) => c.tiles.map((t) => t.session))).toEqual(grid.columns.map((c) => c.tiles.map((t) => t.session)));
  });

  it('tile remoto flottante conserva node/ownerId nel record e al ritorno', () => {
    const l = { columns: [{ width: 1, tiles: [{ session: 'a', node: 'peer', ownerId: 'abcd1234abcd1234', height: 1, fontSize: 11, float: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] }] };
    const { grid, floating } = stripFloating(l);
    expect(floating[0]).toMatchObject({ session: 'a', node: 'peer', ownerId: 'abcd1234abcd1234' });
    const again = materializeFloating(grid, floating);
    const a = again.columns.flatMap((c) => c.tiles).find((t) => t.session === 'a');
    expect(a.node).toBe('peer');
    expect(a.ownerId).toBe('abcd1234abcd1234');
  });
});


// Il flag float è VISTA STABILE — normalize non lo scarta — e le flottanti
// NON contano contro il tetto di 9 tile della griglia: il server le tiene in
// un campo del record a parte.
describe('grid-model — flottanti e normalize', () => {
  const grigliaPiena = () => ({
    columns: Array.from({ length: 3 }, (_, c) => ({
      width: 1,
      tiles: Array.from({ length: 3 }, (_, r) => ({ session: `cell-${c}-${r}`, height: 1, fontSize: 11 })),
    })),
  });

  it('normalize conserva il flag float con la geometria clampata', () => {
    const layout = {
      columns: [{ width: 1, tiles: [
        { session: 'dev', height: 1, fontSize: 11 },
        { session: 'fork', height: 1, fontSize: 11, float: { x: 0.4, y: 9, w: 0.5, h: 0.5 } },
      ] }],
    };
    const out = normalize(layout);
    const fork = out.columns[0].tiles.find((t) => t.session === 'fork');
    // clamp: l'origine rientra nello schermo (y = 1 - h = 0.5)
    expect(fork.float).toEqual({ x: 0.4, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('normalize senza flag non inventa float', () => {
    const out = normalize({ columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }] }] });
    expect(out.columns[0].tiles[0].float).toBeUndefined();
  });

  it('le flottanti materializzano anche con la griglia piena: 9 della griglia + flottante', () => {
    const visto = materializeFloating(grigliaPiena(), [
      { session: 'fl', x: 0.6, y: 0.1, w: 0.4, h: 0.4, fontSize: 11 },
    ]);
    const tiles = visto.columns.flatMap((c) => c.tiles);
    expect(tiles).toHaveLength(10);
    const fl = tiles.find((t) => t.session === 'fl');
    expect(fl.float).toEqual({ x: 0.6, y: 0.1, w: 0.4, h: 0.4 });
  });

  it('il tetto della griglia resta 9 per le aperture normali (addTileSmart)', () => {
    let layout = grigliaPiena();
    layout = addTileSmart(layout, { session: 'extra' });
    expect(layout.columns.flatMap((c) => c.tiles)).toHaveLength(9);
  });

  it('stripFloating separa di nuovo: griglia pura + lista con geometria', () => {
    const visto = materializeFloating(grigliaPiena(), [
      { session: 'fl', x: 0.6, y: 0.1, w: 0.4, h: 0.4, fontSize: 11 },
    ]);
    const { grid, floating } = stripFloating(visto);
    expect(floating).toEqual([{ session: 'fl', x: 0.6, y: 0.1, w: 0.4, h: 0.4, fontSize: 11 }]);
    expect(grid.columns.flatMap((c) => c.tiles)).toHaveLength(9);
  });
});
