import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// U1: il banner di aggiornamento stava fuori schermo sui telefoni stretti (bottone a x=693 su 412 px):
// messaggio in nowrap dentro un contenitore fixed centrato con translateX(-50%). jsdom non fa layout, quindi
// qui si controllano le proprieta' che lo impediscono; la misura reale e' nel referto (Playwright, Pixel 7).
const css = readFileSync(resolve(process.cwd(), 'src/components/UpdatePrompt.css'), 'utf8');
const rule = (sel) => { const m = css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`)); return m ? m[1] : ''; };

describe('UpdatePrompt.css', () => {
  it('il contenitore non supera lo schermo e va a capo', () => {
    const r = rule('.nc-update');
    expect(r).toMatch(/max-width:\s*calc\(100vw\s*-\s*\d+px\)/);
    expect(r).toMatch(/flex-wrap:\s*wrap/);
    expect(r).toMatch(/box-sizing:\s*border-box/);
  });
  it('il messaggio puo\' andare a capo e restringersi; i bottoni no', () => {
    expect(rule('.nc-update-msg')).not.toMatch(/white-space:\s*nowrap/);
    expect(rule('.nc-update-msg')).toMatch(/min-width:\s*0/);
    expect(rule('.nc-update-btn')).toMatch(/flex:\s*none|flex-shrink:\s*0/);
    expect(rule('.nc-update-close')).toMatch(/flex:\s*none|flex-shrink:\s*0/);
  });
});
