import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Contratto SORGENTE CANONICO del pannello file a viewport mobile, sul modello
// di SettingsPanelFleetMobile.test.js (stesso approccio, perimetro ridotto).
//
// PERIMETRO: verifica le dichiarazioni intenzionali scritte nel CSS del
// pannello — che il mobile resti a tutta larghezza, che il nome vada a capo
// ovunque su due righe al massimo, che i bersagli dichiarati siano 40/44 px.
// NON verifica quale dichiarazione vincerebbe davvero in browser: jsdom non
// risolve specificita' ne' !important e non valuta @media in
// getComputedStyle. La misura reale a viewport mobile/desktop sta fuori da
// questa suite, come dichiarato nel test delle impostazioni.
// Soffitto dichiarato: se jsdom non parsa il foglio (sintassi a lui ignota,
// es. @scope), il contratto FALLISCE dicendo di non essere valutabile invece
// di dare un verde senza significato.

// import.meta.url non e' un file:// sotto vitest+vite: il path si risolve
// dalla cwd, che sia frontend/ o la root del repo.
const cssPath = ['src/components/FilesPanel.css', 'frontend/src/components/FilesPanel.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));

const css = readFileSync(cssPath, 'utf8');

const NARROW = 400; // telefono ritratto
const WIDE = 900;   // desktop

class UnparsableByJsdom extends Error {}

function normalizeSelector(selector) {
  return selector.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');
}

function splitSelectorList(selectorText) {
  return selectorText.split(',').map(normalizeSelector).filter(Boolean);
}

const WIDTH_FEATURE = /^\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)$/;

// Una media query conta solo quando si applica con certezza allo schermo alla
// viewport data: type compatibile e vincoli di larghezza soddisfatti, senza
// feature non valutabili.
function certainlyApplies(mediaText, viewport) {
  const queries = String(mediaText || '').toLowerCase().split(',').map((q) => q.trim()).filter(Boolean);
  if (!queries.length) return true;
  return queries.some((query) => {
    if (/^not\b/.test(query)) return false;
    const body = query.replace(/^only\s+/, '').trim();
    const groups = [...body.matchAll(/\([^()]*\)/g)].map((m) => m[0]);
    let rest = body;
    for (const group of groups) rest = rest.replace(group, ' ');
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (token === 'and' || token === 'all' || token === 'screen') continue;
      return false;
    }
    for (const group of groups) {
      const match = WIDTH_FEATURE.exec(group);
      if (!match) return false;
      const value = Number(match[2]);
      if (match[1] === 'max' && viewport > value) return false;
      if (match[1] === 'min' && viewport < value) return false;
    }
    return true;
  });
}

// Valore dichiarato sulle regole con selettore esatto `selector`, nell'ordine
// in cui compaiono: a parita' di selettore vince l'ultima (come in cascata).
function canonicalValue(cssText, selector, property, viewport = NARROW) {
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
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          if (rule.media && !certainlyApplies(rule.media.mediaText, viewport)) continue;
          if (!rule.media) continue;
          walk(rule.cssRules);
          continue;
        }
        if (!rule.selectorText) continue;
        if (!splitSelectorList(rule.selectorText).includes(target)) continue;
        const value = rule.style.getPropertyValue(property);
        if (value) declared = value;
      }
    };
    walk(sheet.cssRules);
    return declared;
  } finally {
    style.remove();
  }
}

describe('FilesPanel — contratto canonico del mobile', () => {
  it('a viewport mobile il pannello occupa tutta la larghezza', () => {
    expect(canonicalValue(css, '.nc-files', 'width')).toBe('100%');
  });

  it('sopra il breakpoint il drawer resta com\'era', () => {
    expect(canonicalValue(css, '.nc-files', 'width', WIDE)).toBe('min(340px, 90vw)');
  });

  it('il nome va a capo ovunque e sta in due righe al massimo', () => {
    expect(canonicalValue(css, '.nc-files li .nc-files-name', 'overflow-wrap')).toBe('anywhere');
    expect(canonicalValue(css, '.nc-files li .nc-files-name', '-webkit-line-clamp')).toBe('2');
  });

  it('badge-tipo 40×40, tasti di riga 44×44', () => {
    expect(canonicalValue(css, '.nc-files-type', 'width')).toBe('40px');
    expect(canonicalValue(css, '.nc-files-type', 'height')).toBe('40px');
    expect(canonicalValue(css, '.nc-files li button', 'min-width')).toBe('44px');
    expect(canonicalValue(css, '.nc-files li button', 'min-height')).toBe('44px');
  });
});

describe('FilesPanel — cosa il contratto intercetta', () => {
  it('il revert diretto della larghezza mobile', () => {
    const reverted = css.replace(/(@media \(max-width: 560px\) \{\s*\.nc-files \{[^}]*?)width: 100%/, '$1width: 75%');
    expect(reverted).not.toBe(css);
    expect(canonicalValue(reverted, '.nc-files', 'width')).toBe('75%');
  });

  it('un override successivo sullo stesso selettore dentro lo stesso media', () => {
    const overridden = `${css}\n@media (max-width: 560px) { .nc-files { width: 75%; } }\n`;
    expect(canonicalValue(overridden, '.nc-files', 'width')).toBe('75%');
  });

  it('la formattazione compressa resta leggibile', () => {
    const squeezed = '@media(max-width:560px){.nc-files{width:100%}}';
    expect(canonicalValue(`${css}\n${squeezed}\n`, '.nc-files', 'width')).toBe('100%');
  });
});
