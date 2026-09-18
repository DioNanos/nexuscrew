import { describe, expect, it } from 'vitest';
import { mergeRemoteWithLocal, refKey, sessions } from './grid-model.js';

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

  it('le colonne solo-remote (nessuna chiave locale) tengono la larghezza remota', () => {
    const remote = { columns: [col([tile('a')]), col([tile('new-remote')])] };
    const local = { columns: [col([tile('a')], 1.7)] };
    const merged = mergeRemoteWithLocal(remote, local);
    expect(merged.columns.map((c) => c.width)).toEqual([1.7, 1]);
  });
});
