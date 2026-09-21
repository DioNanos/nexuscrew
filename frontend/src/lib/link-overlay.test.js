import { describe, expect, it } from 'vitest';

// l'overlay «riconnessione…» è un'informazione, non un riflesso: una
// caduta che si risolve in meno del ritardo non deve farlo comparire, o ogni
// jitter della rete farebbe lampeggiare il terminale. La regola è pura e vive
// qui per essere verificabile senza montare xterm.

import {
  LINK_OVERLAY_DELAY_MS, boundaryNoticeLine, overlayAfterDrop, scrollRestorePlan,
} from './link-overlay.js';

describe('overlay di riconnessione solo dopo il ritardo', () => {
  it('una caduta più breve del ritardo NON mostra l\'overlay', () => {
    expect(overlayAfterDrop(1000, 1000 + LINK_OVERLAY_DELAY_MS - 1)).toBe(false);
  });

  it('la caduta che supera il ritardo lo mostra', () => {
    expect(overlayAfterDrop(1000, 1000 + LINK_OVERLAY_DELAY_MS)).toBe(true);
  });

  it('senza caduta non c\'è overlay', () => {
    expect(overlayAfterDrop(null, 99999)).toBe(false);
    expect(overlayAfterDrop(undefined, 99999)).toBe(false);
  });

  it('il ritardo di default è un secondo', () => {
    expect(LINK_OVERLAY_DELAY_MS).toBe(1000);
  });
});

describe('lo scroll dell\'utente non viene strappato dal repaint', () => {
  it('chi era in fondo resta in fondo', () => {
    // viewportY === baseY: l'utente segue l\'output, il repaint lo riporta lì.
    const plan = scrollRestorePlan({ viewportY: 120, baseY: 120 }, { baseY: 40 });
    expect(plan.atBottom).toBe(true);
    expect(plan.line).toBeNull();
  });

  it('chi stava leggendo indietro torna alla sua riga, entro la nuova coda', () => {
    const plan = scrollRestorePlan({ viewportY: 30, baseY: 120 }, { baseY: 40 });
    expect(plan.atBottom).toBe(false);
    expect(plan.line).toBe(30);
  });

  it('una riga non più esistente viene agganciata alla coda, senza scroll fuori range', () => {
    const plan = scrollRestorePlan({ viewportY: 500, baseY: 520 }, { baseY: 40 });
    expect(plan.atBottom).toBe(false);
    expect(plan.line).toBe(40);
  });
});

describe('riga di confine discreta al ripristino', () => {
  it('si scrive solo se l\'overlay era stato mostrato', () => {
    expect(boundaryNoticeLine(true)).toBeTruthy();
    expect(boundaryNoticeLine(false)).toBe('');
  });

  it('è discreta: nessun colore acceso, nessun testo urlato', () => {
    const line = boundaryNoticeLine(true);
    expect(line).not.toMatch(/\x1b\[(1|31|33|41)m/);
  });
});
