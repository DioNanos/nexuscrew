import { describe, expect, it } from 'vitest';
import {
  addTileSmart, addTileStable, emptyLayout, mergeRemoteWithLocal, moveTile, refKey, sessions, toGrid2x2,
} from './grid-model.js';

const tile = (session) => ({ session, height: 1 });
const col = (tiles, width = 1) => ({ width, tiles });

// Merge remoto ⊕ delta locale senza base a tre vie.
// Identità tile = refKey; il remoto dà la struttura, per le sessioni condivise
// vince la geometria locale, le tile presenti solo in locale sono il delta.
describe('mergeRemoteWithLocal', () => {
  it('aggiunge le tile presenti solo in locale (delta) alla struttura remota', () => {
    const remote = { columns: [col([tile('from-server')])] };
    const local = { columns: [col([tile('edited')])] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(sessions(merged).sort()).toEqual(['edited', 'from-server'].sort());
  });

  it('per una sessione condivisa vince la geometria locale', () => {
    const remote = { columns: [col([{ session: 'dev', height: 1 }])] };
    const local = { columns: [col([{ session: 'dev', height: 9 }])] };
    const merged = mergeRemoteWithLocal(remote, local);
    const kept = merged.columns.flatMap((c) => c.tiles).find((t) => t.session === 'dev');
    expect(kept.height).toBe(9);
  });

  it('le tile solo-remote restano anche se assenti in locale', () => {
    const remote = { columns: [col([tile('a-remote'), tile('b-remote')])] };
    const local = { columns: [col([tile('a-remote')])] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(sessions(merged).sort()).toEqual(['a-remote', 'b-remote']);
  });

  it('è deterministica sull’identità refKey (node:session)', () => {
    const remote = { columns: [col([{ session: 's1', node: 'hub/x', height: 1 }])] };
    const local = { columns: [col([{ session: 's1', node: 'hub/x', height: 4 }])] };
    const merged = mergeRemoteWithLocal(remote, local);
    const keys = merged.columns.flatMap((c) => c.tiles.map((t) => refKey(t)));
    expect(keys).toEqual(['hub/x:s1']);
    expect(merged.columns.flatMap((c) => c.tiles)[0].height).toBe(4);
  });

  it('conserva le larghezze di colonna del delta locale (resize)', () => {
    const remote = { columns: [col([tile('a')]), col([tile('b')])] };
    const local = { columns: [col([tile('a')], 1.7), col([tile('b')], 0.3)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns.map((c) => c.width)).toEqual([1.7, 0.3]);
  });

  it('struttura uguale: le larghezze locali non vengono rinormalizzate', () => {
    const remote = { columns: [col([tile('a')], 1), col([tile('b')], 1)] };
    const local = { columns: [col([tile('a')], 1.7), col([tile('b')], 0.3)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns.map((c) => c.width)).toEqual([1.7, 0.3]);
  });

  it('struttura cambiata: nessuna eredità sbagliata, somma = quella del layout remoto', () => {
    // Il remoto ha spostato `b` in colonna propria: [b] non eredita 1.7
    // (larghezza della vecchia colonna [a,b]); [c] matcha e tiene il resize.
    const remote = { columns: [col([tile('a')], 0.85), col([tile('b')], 0.85), col([tile('c')], 0.3)] };
    const local = { columns: [col([tile('a'), tile('b')], 1.7), col([tile('c')], 0.3)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns.map((c) => c.width)).toEqual([0.85, 0.85, 0.3]);
    const somma = merged.columns.reduce((acc, c) => acc + c.width, 0);
    const sommaRemota = remote.columns.reduce((acc, c) => acc + c.width, 0);
    expect(Math.abs(somma - sommaRemota)).toBeLessThan(1e-9);
  });

  it('colonna fusa dal remoto: tiene la larghezza remota, rinormalizzata alla somma remota', () => {
    const remote = { columns: [col([tile('a'), tile('b')], 1.0)] };
    const local = { columns: [col([tile('a')], 1.7), col([tile('b')], 0.3)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns).toHaveLength(1);
    expect(merged.columns[0].width).toBe(1.0);
  });

  it('colonna divisa dal remoto con tile nuova: resize locali tenuti, la nuova tiene il remoto', () => {
    const remote = { columns: [col([tile('a')], 0.5), col([tile('b')], 0.5), col([tile('c-nuova')], 1.0)] };
    const local = { columns: [col([tile('a')], 1.0), col([tile('b')], 1.0)] };
    const merged = mergeRemoteWithLocal(remote, local);
    // [a] e [b] hanno lo stesso insieme di tile delle colonne locali → larghezza
    // locale; `c-nuova` non matcha nulla → larghezza del remoto.
    expect(merged.columns.map((c) => c.width)).toEqual([1.0, 1.0, 1.0]);
    expect(merged.columns.map((c) => c.tiles.map((t) => t.session)).flat()).toContain('c-nuova');
  });

  it('le colonne solo-remote (nessuna chiave locale) tengono la larghezza remota', () => {
    const remote = { columns: [col([tile('a')]), col([tile('new-remote')])] };
    const local = { columns: [col([tile('a')], 1.7)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns.map((c) => c.width)).toEqual([1.7, 1]);
  });
});

// Posizioni stabili nella riconciliazione post-conflitto: le tile gia'
// presenti conservano colonna/riga; la ridistribuzione bilanciata vale solo
// per il click, non per il merge — l'ordine delle finestre non cambia da solo.
describe('mergeRemoteWithLocal stable placement', () => {
  const positionOf = (layout, session) => {
    for (let c = 0; c < layout.columns.length; c += 1) {
      const r = layout.columns[c].tiles.findIndex((t) => t.session === session);
      if (r >= 0) return `${c}/${r}`;
    }
    return null;
  };

  it('il delta locale si aggiunge senza muovere le tile esistenti (nessun reflow)', () => {
    const remote = { columns: [col([tile('a'), tile('b')])] };
    const local = { columns: [col([tile('a'), tile('b'), tile('delta')])] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(positionOf(merged, 'a')).toBe('0/0');
    expect(positionOf(merged, 'b')).toBe('0/1');
    expect(positionOf(merged, 'delta')).toBe('0/2');
  });

  it('su piu\' colonne il delta va nella meno piena e le altre non si spostano', () => {
    const remote = { columns: [col([tile('a')]), col([tile('b')])] };
    const local = { columns: [col([tile('a')]), col([tile('b'), tile('delta')])] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(positionOf(merged, 'a')).toBe('0/0');
    expect(positionOf(merged, 'b')).toBe('1/0');
    expect(positionOf(merged, 'delta')).toBe('0/1');
  });

  it('addTileStable aggiunge in fondo alla colonna meno piena senza mai rimescolare', () => {
    let layout = { columns: [col([tile('a'), tile('b')]), col([tile('c')])] };
    layout = addTileStable(layout, { session: 'd' });
    expect(positionOf(layout, 'a')).toBe('0/0');
    expect(positionOf(layout, 'b')).toBe('0/1');
    expect(positionOf(layout, 'c')).toBe('1/0');
    expect(positionOf(layout, 'd')).toBe('1/1');
  });

  it('addTileStable su griglia vuota apre la prima colonna', () => {
    const layout = addTileStable(emptyLayout(), 'solo');
    expect(sessions(layout)).toEqual(['solo']);
    expect(layout.columns).toHaveLength(1);
  });

  it('il merge conserva le proprieta\' per-tile del delta (fonte/ownerId/altezza)', () => {
    const remote = { columns: [col([tile('a')])] };
    const local = { columns: [col([tile('a')]), col([{ session: 'delta', height: 2.5, fontSize: 14 }])] };
    const merged = mergeRemoteWithLocal(remote, local);
    const delta = merged.columns.flatMap((c) => c.tiles).find((t) => t.session === 'delta');
    expect(delta.height).toBe(2.5);
    expect(delta.fontSize).toBe(14);
  });

  it('il merge scarta lo stato effimero di disponibilita\' portato dal locale', () => {
    const remote = { columns: [col([tile('a')])] };
    const local = { columns: [col([{ session: 'a', height: 1, unavailable: true, stale: true }])] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(JSON.stringify(merged)).not.toContain('unavailable');
    expect(JSON.stringify(merged)).not.toContain('"stale"');
  });
});

// Lo stato effimero (unavailable/stale) attraversa le trasformazioni di VISTA
// (spostare una tile, preset, aggiunte): la serializzazione lo scarta, ma
// l'utente che muove una finestra offline non la vede tornare viva per un tick.
describe('ephemeral availability survives view transforms', () => {
  const offline = () => ({ session: 'cloud-Fork', height: 1, ownerId: 'f'.repeat(32), unavailable: true });
  const staleTile = () => ({ session: 'cloud-Relay', height: 1, stale: true });

  it('moveTile conserva unavailable (una tile offline spostata resta offline)', () => {
    const layout = { columns: [col([offline()]), col([tile('altro')])] };
    const moved = moveTile(layout, 'cloud-Fork', { col: 1, row: 1 });
    const t = moved.columns.flatMap((c) => c.tiles).find((x) => x.session === 'cloud-Fork');
    expect(t.unavailable).toBe(true);
  });

  it('moveTile conserva anche il badge stale', () => {
    const layout = { columns: [col([staleTile()])] };
    const moved = moveTile(layout, 'cloud-Relay', { col: 0, row: 0 });
    expect(moved.columns[0].tiles[0].stale).toBe(true);
  });

  it('i preset (toGrid2x2) conservano unavailable e stale', () => {
    const layout = { columns: [col([offline(), staleTile()])] };
    const gridded = toGrid2x2(layout);
    const flatTiles = gridded.columns.flatMap((c) => c.tiles);
    expect(flatTiles.find((t) => t.session === 'cloud-Fork').unavailable).toBe(true);
    expect(flatTiles.find((t) => t.session === 'cloud-Relay').stale).toBe(true);
  });

  it('addTileSmart su una vista con tile offline non la resuscita', () => {
    let layout = { columns: [col([offline()])] };
    layout = addTileSmart(layout, 'nuova');
    const t = layout.columns.flatMap((c) => c.tiles).find((x) => x.session === 'cloud-Fork');
    expect(t.unavailable).toBe(true);
    // e la tile NUOVA nasce senza stato effimero
    const fresh = layout.columns.flatMap((c) => c.tiles).find((x) => x.session === 'nuova');
    expect(fresh.unavailable).toBeUndefined();
  });
});
