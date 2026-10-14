import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Contratto SORGENTE CANONICO della vista desktop del pannello file, sul
// modello di FilesPanel.mobile.test.js (stesso approccio, perimetro ridotto).
// La vista desktop non è governata da media query (la accende useDesktop, il
// criterio condiviso R34, tramite la classe nc-files-d): qui si verifica ciò
// che il CSS dichiara per quella vista — drawer largo, dettaglio 340 px, nome
// MAI troncato, riga selezionata con la barra a sinistra.
// Come per il mobile: NON si verifica quale dichiarazione vincerebbe in
// browser (jsdom non risolve la cascata), si verifica il canone scritto.

const cssPath = ['src/components/FilesPanel.desktop.css', 'frontend/src/components/FilesPanel.desktop.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));

const css = readFileSync(cssPath, 'utf8');

class UnparsableByJsdom extends Error {}

function normalizeSelector(selector) {
  return selector.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');
}

// Valore dichiarato sulle regole con selettore esatto `selector`: a parità di
// selettore vince l'ultima (come in cascata). Il foglio desktop non ha @media.
function canonicalValue(cssText, selector, property) {
  const style = document.createElement('style');
  style.textContent = cssText;
  document.head.appendChild(style);
  try {
    const sheet = style.sheet;
    if (!sheet) {
      throw new UnparsableByJsdom(
        'jsdom non ha prodotto un CSSOM per questo foglio: sintassi non supportata dal suo parser. Il contratto non e\' valutabile qui; verificare in browser.',
      );
    }
    const target = normalizeSelector(selector);
    let declared = '';
    for (const rule of sheet.cssRules) {
      if (!rule.selectorText) continue;
      const selettori = rule.selectorText.split(',').map(normalizeSelector).filter(Boolean);
      if (!selettori.includes(target)) continue;
      const value = rule.style.getPropertyValue(property);
      if (value) declared = value;
    }
    return declared;
  } finally {
    style.remove();
  }
}

describe('FilesPanel desktop — contratto canonico', () => {
  it('il drawer desktop è largo (~940 px), sul root marcato nc-files-d', () => {
    expect(canonicalValue(css, '.nc-files.nc-files-d', 'width')).toBe('min(940px, 94vw)');
  });

  it('il pannello dettaglio è fisso a 340 px', () => {
    // jsdom non espande lo shorthand: si legge la dichiarazione com'è scritta
    expect(canonicalValue(css, '.nc-filesd-detail', 'flex')).toBe('0 0 340px');
  });

  it('la lista è una griglia di colonne (badge · nome · ora · dimens. · azioni)', () => {
    expect(canonicalValue(css, '.nc-filesd-row', 'display')).toBe('grid');
  });

  it('il nome va a capo ovunque ed è MAI troncato: niente clamp, niente overflow nascosto', () => {
    expect(canonicalValue(css, '.nc-filesd-name', 'overflow-wrap')).toBe('anywhere');
    expect(canonicalValue(css, '.nc-filesd-name', '-webkit-line-clamp')).toBe('');
    expect(canonicalValue(css, '.nc-filesd-name', 'overflow')).toBe('');
    expect(canonicalValue(css, '.nc-filesd-name', 'text-overflow')).toBe('');
  });

  it('la riga selezionata porta la barra a sinistra', () => {
    expect(canonicalValue(css, '.nc-filesd-row.sel', 'border-left-color')).toBe('#7ee787');
  });
});

describe('FilesPanel desktop — cosa il contratto intercetta', () => {
  it('un clamp reintrodotto sul nome desktop diventa rosso', () => {
    const clamped = `${css}\n.nc-filesd-name { -webkit-line-clamp: 2; }\n`;
    expect(clamped).not.toBe(css);
    expect(canonicalValue(clamped, '.nc-filesd-name', '-webkit-line-clamp')).toBe('2');
  });

  it('un restringimento del drawer si vede', () => {
    const narrowed = css.replace('width: min(940px, 94vw)', 'width: min(340px, 90vw)');
    expect(narrowed).not.toBe(css);
    expect(canonicalValue(narrowed, '.nc-files.nc-files-d', 'width')).toBe('min(340px, 90vw)');
  });
});
