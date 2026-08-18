// R34 — magnifierLayout: la bolla lente sta VICINO alla maniglia attiva, non
// in cima allo schermo. Regole esatte, provabili senza DOM: sopra la maniglia
// per default; se non c'e' spazio ribalta sotto (la maniglia nelle prime righe
// non deve mai finire COPERTA dalla lente); orizzontalmente centrata sull'ancora
// e clampata ai bordi. Coordinate in px nello spazio dell'host del terminale
// (lo stesso di handlePositions).
import { describe, expect, it } from 'vitest';
import { magnifierLayout } from './selection-handles.js';

const base = { hostWidth: 800, hostHeight: 480, bubbleWidth: 300, bubbleHeight: 62 };

describe('R34 — magnifierLayout (bolla lente)', () => {
  it('default: SOPRA la maniglia, centrata sull\'ancora', () => {
    const out = magnifierLayout({ ...base, anchorLeft: 400, anchorTop: 220 });
    expect(out.top).toBe(220 - 8 - 62);   // gap 8 sopra l'ancora
    expect(out.left).toBe(400 - 150);     // centrata
    expect(out.flipped).toBe(false);
  });
  it('maniglia nelle prime righe: ribalta SOTTO (la lente non copre il punto)', () => {
    const out = magnifierLayout({ ...base, anchorLeft: 400, anchorTop: 40 });
    expect(out.top).toBe(40 + 30 + 8);    // sotto la puntina (pinHeight 30) + gap
    expect(out.flipped).toBe(true);
  });
  it('clamp orizzontale: ancora a sinistra → bolla al margine', () => {
    expect(magnifierLayout({ ...base, anchorLeft: 10, anchorTop: 220 }).left).toBe(4);
  });
  it('clamp orizzontale: ancora a destra → bolla al margine destro', () => {
    expect(magnifierLayout({ ...base, anchorLeft: 790, anchorTop: 220 }).left).toBe(800 - 4 - 300);
  });
  it('bolla piu\' larga dell\'host: resta al margine, mai a sinistra negativa', () => {
    expect(magnifierLayout({ ...base, anchorLeft: 400, anchorTop: 220, bubbleWidth: 1000 }).left).toBe(4);
  });
  it('bolla piu\' alta dello spazio sotto E sopra: resta attaccata in cima', () => {
    const out = magnifierLayout({ ...base, anchorTop: 40, hostHeight: 60, bubbleHeight: 80 });
    expect(out.top).toBe(4);
  });
});
