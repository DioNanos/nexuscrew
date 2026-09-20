import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_UNAVAILABLE_TICKS, canonicalizeLayoutForOwner, resolveLayoutForViewer,
  resetOwnerAvailability, tickOwnerAvailability,
} from './deck-federation.js';
import { normalize } from './grid-model.js';

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const LOCAL = 'f'.repeat(32);
const owners = (...ids) => ids.map((id) => ({ instanceId: id, route: [`${id.slice(0, 4)}-node`], label: id.slice(0, 4) }));
const tileOf = (ownerId) => ({ session: 'cloud-Dev', height: 1, fontSize: 11, ownerId });
const layoutWith = (...tiles) => ({ columns: [{ width: 1, tiles }] });
const flat = (layout) => layout.columns.flatMap((c) => c.tiles);

// Isteresi di disponibilita': un owner transitive che manca per UN poll non
// spegne la tile. Il contatore e' effimero (Map a lato, mai nel deck salvato).
describe('owner availability hysteresis', () => {
  beforeEach(() => resetOwnerAvailability());

  it(`owner assente per ${OWNER_UNAVAILABLE_TICKS - 1} poll: la tile resta disponibile, route in cache, badge stale`, () => {
    tickOwnerAvailability(owners(OWNER_A));
    for (let i = 1; i < OWNER_UNAVAILABLE_TICKS; i += 1) tickOwnerAvailability(owners());
    const viewed = resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, []);
    const tile = flat(viewed)[0];
    expect(tile.unavailable).toBeUndefined();
    expect(tile.stale).toBe(true);
    expect(tile.node).toBe('aaaa-node');
  });

  it(`owner assente per ${OWNER_UNAVAILABLE_TICKS} poll consecutivi: la tile diventa unavailable`, () => {
    tickOwnerAvailability(owners(OWNER_A));
    for (let i = 0; i < OWNER_UNAVAILABLE_TICKS; i += 1) tickOwnerAvailability(owners());
    const tile = flat(resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, []))[0];
    expect(tile.unavailable).toBe(true);
    expect(tile.stale).toBeUndefined();
  });

  it('owner che torna: contatore azzerato, la tile torna subito viva senza badge', () => {
    tickOwnerAvailability(owners(OWNER_A));
    tickOwnerAvailability(owners());
    tickOwnerAvailability(owners(OWNER_A));
    const tile = flat(resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, owners(OWNER_A)))[0];
    expect(tile.unavailable).toBeUndefined();
    expect(tile.stale).toBeUndefined();
    // il ritorno azzera davvero: un singolo miss successivo resta dentro l'isteresi
    tickOwnerAvailability(owners());
    const after = flat(resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, []))[0];
    expect(after.unavailable).toBeUndefined();
  });

  it('owner presente ma marcato stale dal server: tile viva con la sua route e badge stale', () => {
    const staleOwners = [{ instanceId: OWNER_B, route: ['bbbb-node'], label: 'bbbb', stale: true }];
    tickOwnerAvailability(staleOwners);
    const tile = flat(resolveLayoutForViewer(layoutWith(tileOf(OWNER_B)), LOCAL, staleOwners))[0];
    expect(tile.unavailable).toBeUndefined();
    expect(tile.stale).toBe(true);
    expect(tile.node).toBe('bbbb-node');
  });

  it('owner mai visto in questa sessione: unavailable subito (nessun trust di hint di compatibilità)', () => {
    const tile = flat(resolveLayoutForViewer(layoutWith(tileOf(OWNER_B)), LOCAL, []))[0];
    expect(tile.unavailable).toBe(true);
  });

  it('owner locale: mai unavailable né stale, mai route hint', () => {
    tickOwnerAvailability(owners(LOCAL));
    const tile = flat(resolveLayoutForViewer(layoutWith({ ...tileOf(LOCAL), node: 'legacy' }), LOCAL, owners(LOCAL)))[0];
    expect(tile.unavailable).toBeUndefined();
    expect(tile.stale).toBeUndefined();
    expect(tile.node).toBeUndefined();
  });
});

// Stato effimero: unavailable/stale non sopravvivono a nessuna serializzazione
// (normalizzazione in lettura/scrittura, canonicalizzazione verso l'owner).
// Un flip di disponibilita' non produce differenze di confronto: zero PUT.
describe('ephemeral availability state is never serialized', () => {
  beforeEach(() => resetOwnerAvailability());

  it('normalize scarta unavailable/stale ovunque (incluso layout da storage)', () => {
    tickOwnerAvailability(owners(OWNER_A));
    tickOwnerAvailability(owners());
    const viewed = resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, []);
    expect(flat(viewed)[0].stale).toBe(true);
    const cleaned = normalize(viewed);
    const withFlags = JSON.stringify(cleaned);
    expect(withFlags).not.toContain('unavailable');
    expect(withFlags).not.toContain('"stale"');
    // geometria intatta: il tile resta, con ownerId e route hint
    expect(flat(cleaned)[0].session).toBe('cloud-Dev');
    expect(flat(cleaned)[0].ownerId).toBe(OWNER_A);
  });

  it('un flip di disponibilita non cambia il layout serializzato (precondizione zero-PUT)', () => {
    const base = layoutWith(tileOf(OWNER_A));
    tickOwnerAvailability(owners(OWNER_A));
    const alive = resolveLayoutForViewer(base, LOCAL, owners(OWNER_A));
    tickOwnerAvailability(owners());
    const stale = resolveLayoutForViewer(base, LOCAL, []);
    expect(JSON.stringify(normalize(alive))).toBe(JSON.stringify(normalize(stale)));
  });

  it('canonicalizeLayoutForOwner rimuove anche stale, non solo unavailable', () => {
    tickOwnerAvailability(owners(OWNER_A));
    tickOwnerAvailability(owners());
    const viewed = resolveLayoutForViewer(layoutWith(tileOf(OWNER_A)), LOCAL, []);
    const canonical = canonicalizeLayoutForOwner(viewed, LOCAL, []);
    expect(JSON.stringify(canonical)).not.toContain('stale');
    expect(JSON.stringify(canonical)).not.toContain('unavailable');
  });
});
