import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Contratto SORGENTE CANONICO della lista Fleet a viewport stretta.
//
// PERIMETRO, dichiarato per intero perche' la sua parte piu' importante e' cio'
// che NON copre.
//
// Verifica: le dichiarazioni intenzionali sulle regole canoniche del pannello,
// e il fatto che restino tali. Intercetta quindi una regressione scritta dove
// vive il contratto — revert della dichiarazione, override successivo con lo
// stesso selettore, deriva dei valori.
//
// NON verifica: quale dichiarazione vincerebbe davvero in un browser. Non
// rileva regole concorrenti scritte con selettori diversi ma equivalenti o piu'
// specifici (`:is(.nc-fleet-item)`, `[class~="nc-fleet-item"]`,
// `.nc-fleet\-item`, `.nc-fleet-unmanaged.nc-fleet-item`,
// `.nc-fleet-item:nth-child(3)`), ne' proprieta' concorrenti che riscrivono il
// risultato per altra via (`place-items`, `align-self` sul figlio, `all`), ne'
// `!important`, ne' regole dentro grouping rule non valutabili qui.
//
// Soffitto ulteriore, dichiarato: il parser di jsdom non copre tutta la
// sintassi che un browser accetta (per esempio `@scope` o il nesting CSS). Se
// il foglio ne contiene, il CSSOM e' nullo e il contratto fallisce dichiarando
// di non essere valutabile, invece di dare un verde privo di significato.
//
// Il motivo non e' pigrizia: jsdom non applica specificita' ne' `!important` e
// non valuta `@media`/`@supports` in getComputedStyle, quindi in questo
// ambiente la cascata non e' calcolabile, e tre tentativi successivi di
// approssimarla hanno prodotto ogni volta falsi verdi o falsi rossi nuovi. La
// verifica sulla cascata effettiva sta dove puo' stare: nella misura in browser
// a viewport mobile e desktop, eseguita fuori da questa suite.
//
// Il difetto che il contratto presidia: sotto i 520px .nc-fleet-item diventa una
// colonna, quindi l'asse trasversale passa a orizzontale. Con
// align-items:flex-start le due span si dimensionano a max-content invece che
// alla larghezza della riga; min-width:0 vale solo sull'asse principale e
// max-width:100% su b/small si risolve contro un genitore gia' cresciuto, cosi'
// text-overflow:ellipsis non scatta mai.

// import.meta.url non e' un file:// sotto vitest+vite, quindi il path si risolve
// dalla cwd: `npm --prefix frontend test` gira in frontend/, la variante con
// prefisso copre l'esecuzione dalla root del repo.
const cssPath = ['src/components/SettingsPanel.css', 'frontend/src/components/SettingsPanel.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));

const css = readFileSync(cssPath, 'utf8');

// Viewport di prova dentro e fuori dal breakpoint mobile. Servono a scegliere
// quali @media leggere, non a misurare larghezze.
const NARROW = 400;
const WIDE = 900;

// Soffitto dichiarato: jsdom non parsa tutta la sintassi CSS che un browser
// accetta. Se il foglio ne contiene, il CSSOM e' nullo e il contratto non e'
// valutabile: fallisce dicendolo, invece di dare un verde privo di significato.
class UnparsableByJsdom extends Error {}

function normalizeSelector(selector) {
  return selector.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ');
}

// Tokenizer condiviso da selector-list e media-list: divide solo a profondita'
// zero, fuori da parentesi tonde e quadre e fuori dalle stringhe, rispettando
// gli escape (un `\"` dentro una stringa non la chiude, e nemmeno un `\(`).
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let current = '';
  for (const ch of text) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\') { current += ch; escaped = true; continue; }
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === separator && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function splitSelectorList(selectorText) {
  return splitTopLevel(selectorText, ',').map(normalizeSelector).filter(Boolean);
}

// Gruppi parentesizzati di primo livello, per non scambiare `(unknown(foo,bar))`
// per due feature distinte.
function topLevelGroups(text) {
  const groups = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) { groups.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return groups;
}

// Ancorata sull'intera feature: `(foo-max-width: 520px)` non e' `(max-width: …)`.
const WIDTH_FEATURE = /^\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)$/;

// Una media query e' considerata solo quando si applica con certezza: media
// type compatibile con lo schermo e vincoli di larghezza soddisfatti, senza
// feature che questo helper non sa valutare. Tutto il resto viene ignorato,
// coerentemente col perimetro dichiarato sopra.
function certainlyApplies(mediaText, viewport) {
  const queries = splitTopLevel((mediaText || '').toLowerCase(), ',')
    .map((q) => q.trim())
    .filter(Boolean);
  if (!queries.length) return true;
  return queries.some((query) => {
    if (/^not\b/.test(query)) return false;
    const body = query.replace(/^only\s+/, '').trim();
    const groups = topLevelGroups(body);

    // Fuori dai gruppi devono restare solo il media type e `and`: qualunque
    // altro token (a partire da `or`) rende la query non valutabile.
    let rest = body;
    for (const group of groups) rest = rest.replace(group, ' ');
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (token === 'and' || token === 'all' || token === 'screen') continue;
      return false;
    }

    for (const group of groups) {
      const match = WIDTH_FEATURE.exec(group);
      if (!match) return false; // feature non valutabile: la query non e' certa
      const value = Number(match[2]);
      if (match[1] === 'max' && viewport > value) return false;
      if (match[1] === 'min' && viewport < value) return false;
    }
    return true;
  });
}

// Valore dichiarato sulle regole il cui selettore e' esattamente `selector`,
// nell'ordine in cui compaiono: a parita' di selettore vince l'ultima.
function canonicalValue(cssText, selector, property, viewport = NARROW) {
  const style = document.createElement('style');
  style.textContent = cssText;
  document.head.appendChild(style);
  try {
    const sheet = style.sheet;
    if (!sheet) {
      throw new UnparsableByJsdom(
        'jsdom non ha prodotto un CSSOM per questo foglio di stile: sintassi non supportata dal suo parser (per esempio @scope o il nesting CSS). Il contratto non e\' valutabile qui; verificare in browser.',
      );
    }
    const target = normalizeSelector(selector);
    let declared = '';
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          if (rule.media && !certainlyApplies(rule.media.mediaText, viewport)) continue;
          if (!rule.media) continue; // grouping rule non valutabili: fuori perimetro
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

const after = (extra) => `${css}\n${extra}\n`;

describe('SettingsPanel — contratto canonico della lista Fleet', () => {
  it('a viewport stretta la riga stira le span invece di lasciarle a max-content', () => {
    expect(canonicalValue(css, '.nc-fleet-item', 'flex-direction')).toBe('column');
    expect(canonicalValue(css, '.nc-fleet-item', 'align-items')).toBe('stretch');
  });

  it('sopra il breakpoint la riga resta orizzontale e centrata', () => {
    expect(canonicalValue(css, '.nc-fleet-item', 'flex-direction', WIDE)).toBe('');
    expect(canonicalValue(css, '.nc-fleet-item', 'align-items', WIDE)).toBe('center');
  });

  it('la colonna azioni resta a piena larghezza', () => {
    expect(canonicalValue(css, '.nc-fleet-item > span:last-child', 'width')).toBe('100%');
  });

  it('preserva la catena di troncamento su cui poggia il fix', () => {
    // Senza questi pezzi lo stretch non basta: le span devono poter scendere
    // sotto il contenuto e b/small devono troncare dentro la larghezza imposta.
    expect(canonicalValue(css, '.nc-fleet-item > span', 'min-width')).toMatch(/^0(px)?$/);
    expect(canonicalValue(css, '.nc-fleet-item > span:first-child', 'min-width')).toMatch(/^0(px)?$/);
    for (const selector of [
      '.nc-fleet-item > span:first-child b',
      '.nc-fleet-item > span:first-child small',
    ]) {
      expect(canonicalValue(css, selector, 'max-width')).toBe('100%');
      expect(canonicalValue(css, selector, 'overflow')).toBe('hidden');
      expect(canonicalValue(css, selector, 'text-overflow')).toBe('ellipsis');
      expect(canonicalValue(css, selector, 'white-space')).toBe('nowrap');
    }
  });
});

describe('SettingsPanel — cosa il contratto intercetta', () => {
  it('il revert diretto della dichiarazione', () => {
    const reverted = css.replace(/(\.nc-fleet-item\s*\{[^}]*?align-items:\s*)stretch/, '$1flex-start');
    expect(reverted).not.toBe(css);
    expect(canonicalValue(reverted, '.nc-fleet-item', 'align-items')).toBe('flex-start');
  });

  it('un override successivo scritto sullo stesso selettore', () => {
    const overridden = after('@media (max-width: 520px) { .nc-fleet-item { align-items: flex-start; } }');
    expect(canonicalValue(overridden, '.nc-fleet-item', 'align-items')).toBe('flex-start');
  });

  it('resta indipendente dalla formattazione', () => {
    const spaced = '@media (max-width: 520px) { .nc-fleet-item { align-items: stretch; flex-direction: column; } }';
    const squeezed = '@media(max-width:520px){.nc-fleet-item{align-items:stretch;flex-direction:column}}';
    expect(spaced).not.toBe(squeezed);
    expect(canonicalValue(spaced, '.nc-fleet-item', 'align-items')).toBe('stretch');
    expect(canonicalValue(squeezed, '.nc-fleet-item', 'align-items')).toBe('stretch');
  });
});

describe('SettingsPanel — cosa il contratto non intercetta, per costruzione', () => {
  // Questi casi sono documentazione eseguibile del perimetro: passano, e devono
  // passare, perche' il contratto legge le regole canoniche e non risolve la
  // cascata. In browser ognuno di essi riporterebbe il bug. Se un giorno si
  // vorra' coprirli servira' un motore reale, non un altro giro di euristiche.
  it.each([
    ['selettore equivalente', '@media (max-width: 520px) { :is(.nc-fleet-item) { align-items: flex-start; } }'],
    ['classe con escape CSS', '@media (max-width: 520px) { .nc-fleet\\-item { align-items: flex-start; } }'],
    ['selettore a specificita maggiore', '@media (max-width: 520px) { .nc-fleet-unmanaged.nc-fleet-item { align-items: flex-start; } }'],
    ['selettore posizionale', '@media (max-width: 520px) { .nc-fleet-item:nth-child(3) { align-items: flex-start; } }'],
    ['shorthand concorrente', '@media (max-width: 520px) { .nc-fleet-item { place-items: flex-start; } }'],
    ['override sul figlio', '@media (max-width: 520px) { .nc-fleet-item > span:first-child { align-self: flex-start; } }'],
    ['reset globale', '@media (max-width: 520px) { .nc-fleet-item { all: initial; } }'],
    ['priorita important', '@media (max-width: 520px) { :is(.nc-fleet-item) { align-items: flex-start !important; } }'],
  ])('non rileva %s', (_label, extra) => {
    expect(canonicalValue(after(extra), '.nc-fleet-item', 'align-items')).toBe('stretch');
  });
});

describe('SettingsPanel — cosa il contratto non deve bloccare', () => {
  it.each([
    ['un media che non si applica allo schermo', '@media print { .nc-fleet-item { align-items: flex-start; } }'],
    ['un media con feature non valutabile', '@media (orientation: landscape) { .nc-fleet-item { align-items: flex-start; } }'],
    ['un selettore col nome della classe come prefisso', '@media (max-width: 520px) { .nc-fleet-item-decoy { align-items: flex-start; } }'],
    ['una regola estranea con virgole dentro :is()', '.other:is(.foo, .bar) { align-items: center; }'],
    ['una regola estranea con virgole dentro un attributo', '[data-x="a,b"] { align-items: center; }'],
    ['una proprieta fuori contratto sulla riga', '.nc-fleet-item:hover { border-color: red; }'],
    ['una feature con prefisso simile a max-width', '@media (foo-max-width: 520px) { .nc-fleet-item { align-items: flex-start; } }'],
    ['una feature ignota con virgole annidate', '@media (unknown(foo, bar)) { .nc-fleet-item { align-items: flex-start; } }'],
    ['una combinazione media non valutata', '@media (max-width: 520px) or (min-width: 900px) { .nc-fleet-item { align-items: flex-start; } }'],
  ])('%s', (_label, extra) => {
    expect(canonicalValue(after(extra), '.nc-fleet-item', 'align-items')).toBe('stretch');
    expect(canonicalValue(after(extra), '.nc-fleet-item', 'flex-direction')).toBe('column');
  });

  it('una selector-list con quote escapato resta leggibile', () => {
    // Il quote escapato non chiude la stringa, quindi la virgola successiva e'
    // davvero di primo livello e `.nc-fleet-item` e' un membro esatto: qui il
    // contratto deve accorgersi dell'override, non ignorarlo.
    const extra = '@media (max-width: 520px) { [data-x="a\\",b"], .nc-fleet-item { align-items: flex-start; } }';
    expect(canonicalValue(after(extra), '.nc-fleet-item', 'align-items')).toBe('flex-start');
  });
});

describe('SettingsPanel — soffitto del parser, dichiarato', () => {
  it('fallisce dicendolo quando jsdom non parsa il foglio', () => {
    // @scope e' CSS valido che il browser applica ma che jsdom non parsa: il
    // CSSOM diventa nullo e nessuna lettura e' possibile. Il contratto lo
    // segnala invece di restituire un verde privo di significato. E' un limite
    // noto, non un difetto nascosto: se comparira' nel progetto, questo test
    // sara' il posto dove decidere come procedere.
    const extra = '@scope (.foo) { .unrelated { color: red; } }';
    expect(() => canonicalValue(after(extra), '.nc-fleet-item', 'align-items')).toThrow(UnparsableByJsdom);
  });
});
