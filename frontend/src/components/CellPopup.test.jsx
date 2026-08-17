import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

// R24 — la finestra del popup si sposta, si ridimensiona, ricorda la
// geometria. Il punto che decide se funziona: dentro c'e' un IFRAME che si
// mangia gli eventi del mouse, quindi il test di trascinamento attraversa il
// CONTENUTO con un velo attivo — non due pixel lungo il bordo, che restano
// verdi anche senza velo (il difetto invisibile di questa feature).

vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import CellPopup from './CellPopup.jsx';

const KEY = 'nc_popup_assetto';

function matchMediaFisso(matches) {
  const mq = { matches, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => mq));
  return mq;
}

// Geometria di default ATTESA (le misure del CSS calcolate, come fa il
// componente — non lette dal layout).
function daCentro() {
  const vw = window.innerWidth; const vh = window.innerHeight;
  const w = Math.min(1100, Math.floor(vw * 0.96));
  const h = Math.min(820, Math.floor(vh * 0.92));
  return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CellPopup R24: finestra spostabile e ridimensionabile', () => {
  it('trascinamento ATTRAVERSO il contenuto: velo attivo per tutto il drag, finestra che segue, geometria salvata', () => {
    matchMediaFisso(false);
    const { container } = render(
      <CellPopup title="Dev" onClose={() => {}}>
        <iframe title="desktop" src="/panel/Dev/?ticket=T" />
      </CellPopup>,
    );
    const popup = container.querySelector('.nc-popup');
    const testa = container.querySelector('.nc-popup-testa');
    const { x: x0, y: y0 } = daCentro();

    fireEvent.mouseDown(testa, { button: 0, clientX: x0 + 20, clientY: y0 + 10 });
    // Il velo esiste per la sola durata del drag: e' la superficie che nei
    // browser veri impedisce all'iframe di catturare il puntatore.
    expect(container.querySelector('.nc-popup-velo-drag')).toBeTruthy();

    // Spostamento LUNGO, attraverso l'area del contenuto: il puntatore passa
    // sopra la zona dell'iframe (300×200 px, non due pixel dal bordo). Gli
    // eventi arrivano via window, come li consegna il browser quando il
    // cursore ha lasciato la barra — e sopra l'iframe, in un browser vero,
    // sarebbe il velo a riceverli.
    fireEvent.mouseMove(window, { clientX: x0 + 20 + 300, clientY: y0 + 10 + 200 });
    expect(popup.style.left).toBe(`${x0 + 300}px`);
    expect(popup.style.top).toBe(`${y0 + 200}px`);

    fireEvent.mouseUp(window);
    // Al rilascio il velo sparisce: l'iframe torna interagibile.
    expect(container.querySelector('.nc-popup-velo-drag')).toBeNull();
    // Posizione e dimensione ricordate fra le aperture.
    expect(JSON.parse(window.localStorage.getItem(KEY))).toMatchObject({ x: x0 + 300, y: y0 + 200 });
  });

  it('la X chiude, non trascina: il drag non parte dal bottone', () => {
    matchMediaFisso(false);
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const chiudi = container.querySelector('.nc-popup-chiudi');
    fireEvent.mouseDown(chiudi, { button: 0, clientX: 10, clientY: 10 });
    expect(container.querySelector('.nc-popup-velo-drag')).toBeNull();
  });

  it('ridimensionamento dall\'angolo con minimo sensato', () => {
    matchMediaFisso(false);
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const angolo = container.querySelector('.nc-popup-angolo');
    expect(angolo).toBeTruthy();
    fireEvent.mouseDown(angolo, { button: 0, clientX: 900, clientY: 700 });
    expect(container.querySelector('.nc-popup-velo-drag')).toBeTruthy();
    // Stringe MOLTO sotto il minimo: si ferma al minimo, non ci passa sotto.
    fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
    const popup = container.querySelector('.nc-popup');
    expect(popup.style.width).toBe('320px');
    expect(popup.style.height).toBe('240px');
    fireEvent.mouseUp(window);
    expect(container.querySelector('.nc-popup-velo-drag')).toBeNull();
  });

  it('posizione e dimensione salvate si riaprono con la finestra', () => {
    matchMediaFisso(false);
    window.localStorage.setItem(KEY, JSON.stringify({ x: 50, y: 60, w: 500, h: 400 }));
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    expect(popup.style.left).toBe('50px');
    expect(popup.style.top).toBe('60px');
    expect(popup.style.width).toBe('500px');
    expect(popup.style.height).toBe('400px');
  });

  it('doppio clic sulla barra: torna al centro e dimentica la posizione', () => {
    matchMediaFisso(false);
    window.localStorage.setItem(KEY, JSON.stringify({ x: 50, y: 60, w: 500, h: 400 }));
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    expect(popup.style.left).toBe('50px');
    fireEvent.doubleClick(container.querySelector('.nc-popup-testa'));
    expect(popup.style.left).toBe('');
    expect(popup.classList.contains('nc-popup-libera')).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('sotto i 720px: schermo pieno e trascinamento DISATTIVATO, non solo nascosto', () => {
    matchMediaFisso(true);
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    // Niente geometria inline: il CSS a schermo pieno comanda da solo.
    expect(popup.style.left).toBe('');
    fireEvent.mouseDown(container.querySelector('.nc-popup-testa'), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 310, clientY: 210 });
    expect(container.querySelector('.nc-popup-velo-drag')).toBeNull();
    expect(popup.style.left).toBe('');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('la finestra non puo\' finire fuori schermo: la barra resta afferrabile', () => {
    matchMediaFisso(false);
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    const testa = container.querySelector('.nc-popup-testa');
    const { w } = daCentro();
    fireEvent.mouseDown(testa, { button: 0, clientX: 500, clientY: 10 });
    // Prova a buttarla MOLTO oltre il bordo destro e sopra il bordo alto.
    fireEvent.mouseMove(window, { clientX: 5000, clientY: -5000 });
    expect(popup.style.left).toBe(`${window.innerWidth - 48}px`);
    expect(popup.style.top).toBe('0px');
    // E molto oltre il bordo sinistro: almeno un pezzo di barra resta dentro.
    fireEvent.mouseMove(window, { clientX: -5000, clientY: 10 });
    expect(popup.style.left).toBe(`${-(w - 48)}px`);
    fireEvent.mouseUp(window);
  });

  it('clamp BASSO: oltre il fondo la barra resta visibile (y <= vh - altezza barra)', () => {
    // L'audit: la dichiarazione copriva sinistro, destro e alto, ma il
    // vincolo basso (top mai oltre vh - TESTA) non era esercitato da
    // nessuno. Nota: TESTA=44 non e' GRAB=48 — sono due misure per due lati
    // diversi, e il test pretende esattamente quella bassa.
    matchMediaFisso(false);
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    const testa = container.querySelector('.nc-popup-testa');
    fireEvent.mouseDown(testa, { button: 0, clientX: 500, clientY: 10 });
    // Prova a buttarla MOLTO sotto il bordo basso.
    fireEvent.mouseMove(window, { clientX: 500, clientY: 5000 });
    expect(popup.style.top).toBe(`${window.innerHeight - 44}px`);
    // E risali oltre il bordo alto: li' il vincolo e' totale (top >= 0).
    fireEvent.mouseMove(window, { clientX: 500, clientY: -5000 });
    expect(popup.style.top).toBe('0px');
    fireEvent.mouseUp(window);
  });

  it('ritorno da mobile a desktop: la geometria salvata viene riletta e riclampata', () => {
    // Il ramo useEffect([mobile]) che rilegge la posizione quando si torna
    // da mobile: prima non aveva test. Si guida il listener che il
    // componente registra su matchMedia.
    const mq = matchMediaFisso(true);
    window.localStorage.setItem(KEY, JSON.stringify({ x: 50, y: 60, w: 500, h: 400 }));
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    // Fase mobile: schermo pieno, nessuna geometria inline.
    expect(popup.style.left).toBe('');
    const cambio = mq.addEventListener.mock.calls.find((c) => c[0] === 'change');
    expect(cambio).toBeTruthy();
    const fire = cambio[1];
    // La viewport torna desktop: il componente rilegge la geometria salvata.
    act(() => { fire({ matches: false }); });
    expect(popup.style.left).toBe('50px');
    expect(popup.style.top).toBe('60px');
    expect(popup.style.width).toBe('500px');
    expect(popup.style.height).toBe('400px');
    // E il trascinamento torna attivo davvero: un drag sposta la finestra.
    fireEvent.mouseDown(container.querySelector('.nc-popup-testa'), { button: 0, clientX: 100, clientY: 70 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 170 });
    expect(popup.style.left).toBe('150px');
    fireEvent.mouseUp(window);
  });

  it('viewport che si rimpicciolisce: la posizione salvata rientra invece di sparire', () => {
    matchMediaFisso(false);
    window.localStorage.setItem(KEY, JSON.stringify({ x: 900, y: 700, w: 400, h: 300 }));
    const { container } = render(<CellPopup title="Dev" onClose={() => {}}><div /></CellPopup>);
    const popup = container.querySelector('.nc-popup');
    expect(popup.style.left).toBe('900px');
    // La finestra del browser si riduce: 600px di larghezza.
    vi.stubGlobal('innerWidth', 600);
    fireEvent(window, new Event('resize'));
    expect(popup.style.left).toBe(`${600 - 48}px`);
  });
});
