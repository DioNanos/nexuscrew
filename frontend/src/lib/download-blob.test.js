import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBlobAs } from './download-blob.js';

// Contratto del salvataggio blob: anchor nel DOM (il click programmatico su
// anchor detached è meno affidabile su alcuni engine mobile) e revoca
// dell'object URL RITARDATA (il download manager dereferenzia il blob dopo il
// ritorno di click(): una revoca sincrona gareggia col download e può
// ucciderlo in silenzio).
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('saveBlobAs', () => {
  it('attacca l\'anchor al document.body al click e lo rimuove subito dopo', () => {
    const alClick = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      // la presenza nel DOM si cattura DENTRO il click: dopo il ritorno
      // l'anchor è già stato rimosso (che è il comportamento voluto)
      alClick.push({ a: this, inBody: document.body.contains(this) });
    });
    saveBlobAs(new Blob(['x']), 'report.pdf');
    expect(click).toHaveBeenCalledTimes(1);
    expect(alClick[0].a.download).toBe('report.pdf');
    expect(alClick[0].a.href).toContain('blob:x');
    // al momento del click l'anchor è nel documento…
    expect(alClick[0].inBody).toBe(true);
    // …e non ci resta dopo
    expect(alClick[0].a.isConnected).toBe(false);
    expect(document.querySelector('a[download="report.pdf"]')).toBeNull();
    click.mockRestore();
  });

  it('revoca l\'object URL solo dopo un ritardo, mai in modo sincrono', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      saveBlobAs(new Blob(['x']), 'a.txt');
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
    } finally {
      vi.useRealTimers();
      click.mockRestore();
    }
  });
});
