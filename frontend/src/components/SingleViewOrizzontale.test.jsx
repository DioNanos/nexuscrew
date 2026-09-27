import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// La doppia vista in ORIZZONTALE (design approvato):
// i due pannelli si AFFIANCANO con la maniglia verticale (il confine segue
// il dito su clientX, pesi H separati da quelli V); se la cella più stretta
// scende sotto ~40 colonne al font corrente si vede SOLO la cella col focus
// — l'altra resta MONTATA e nascosta (mai un terminale ricreato) — con il
// tasto-icona per passarle. Lo stesso file-spia di SingleViewDual.test.jsx
// conta istanze e connessioni: la rotazione non ne deve creare una.

const fixture = vi.hoisted(() => ({ sessions: {}, cells: {} }));
const spie = vi.hoisted(() => ({ perSessione: {} }));
const orientamento = vi.hoisted(() => ({ landscape: false, listeners: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (url) => {
    const base = url.replace(/\/sessions$/, '');
    const sessions = fixture.sessions[base] ?? [];
    return { json: async () => ({ sessions }) };
  }),
  fleetStatus: vi.fn(async (_token, route) => {
    const key = (route || []).join('/');
    return { available: true, cells: fixture.cells[key] ?? [] };
  }),
  fleetUp: vi.fn(), fleetDown: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), setSessionTechnical: vi.fn(),
}));

vi.mock('./Terminal.jsx', () => ({
  default: function TermSpia({ session, composerRef, sendRef, actionRef, focused, readonly, takeSize, onFiles }) {
    const spia = spie.perSessione[session]
      || (spie.perSessione[session] = { pastes: [], keys: [], actions: [], props: {}, socket: 0, istanze: 0 });
    spia.props = { focused, readonly, takeSize };
    React.useEffect(() => {
      spia.socket += 1;
    }, [session, readonly, takeSize, onFiles]);
    React.useEffect(() => {
      spia.istanze += 1;
    }, []);
    composerRef.current = async (text) => { spia.pastes.push(text); return true; };
    sendRef.current = (seq) => { spia.keys.push(seq); return true; };
    actionRef.current = (name) => { spia.actions.push(name); return true; };
    return <div data-testid="term" data-term-session={session} />;
  },
}));
vi.mock('./KeyBar.jsx', () => ({
  default: ({ send, onKeyboard }) => (
    <div>
      <button data-testid="kb-kb" onClick={onKeyboard}>kb</button>
      <button data-testid="kb-send" onClick={() => send('ESC')}>send</button>
    </div>
  ),
}));
vi.mock('./ComposerBar.jsx', () => ({
  default: ({ submitText, session }) => (
    <button data-testid="invio" data-target={session} onClick={() => submitText('ping')}>invia</button>
  ),
}));
vi.mock('./FilesPanel.jsx', () => ({ default: ({ session }) => <div data-testid="files" data-files-session={session} /> }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('./SessionList.jsx', () => ({ default: () => null }));
vi.mock('./Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./GridView.jsx', () => ({ default: () => null }));
vi.mock('./PowerSheet.jsx', () => ({ default: () => null }));
vi.mock('./DeckBar.jsx', () => ({ default: () => null }));
vi.mock('./SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./Wizard.jsx', () => ({ default: () => null }));
vi.mock('./NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import { SingleView } from '../App.jsx';

beforeAll(() => {
  // Il mock orientabile: la query landscape risponde con la variabile del
  // test e REGISTRA i listener, così «ruotare» è notificare i listener.
  window.matchMedia = (q) => ({
    get matches() {
      if (q.includes('orientation: landscape')) return orientamento.landscape;
      return false;
    },
    media: q, onchange: null,
    addEventListener(_tipo, fn) {
      if (q.includes('orientation: landscape')) orientamento.listeners.push(fn);
    },
    removeEventListener(_tipo, fn) {
      orientamento.listeners = orientamento.listeners.filter((f) => f !== fn);
    },
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
});

beforeEach(() => {
  orientamento.landscape = false;
  orientamento.listeners = [];
  spie.perSessione = {};
  fixture.sessions = {
    '/api': [
      { name: 'cloud-Dev', activity: 0, attached: false, windows: 1 },
      { name: 'cloud-Fork', activity: 0, attached: false, windows: 1 },
    ],
  };
  fixture.cells = {
    '': [
      { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' },
      { cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'claude.native', key: 'A' },
    ],
  };
  localStorage.clear();
});

function ruota(landscape) {
  orientamento.landscape = landscape;
  for (const fn of [...orientamento.listeners]) fn({ matches: landscape });
}

function monta() {
  return render(
    <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()}
      side={{ session: 'cloud-Fork' }}
      onSideClose={vi.fn()} onSideGone={vi.fn()} />,
  );
}

// jsdom non ha PointerEvent: per il drag servono le COORDINATE (clientX/Y);
// un MouseEvent 'pointerdown/move/up' che bolle raggiunge gli stessi
// listener React e su window, ma porta con sé le coordinate vere.
const premici = (elemento, init = {}) =>
  elemento.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, ...init }));
const muovici = (bersaglio, init = {}) =>
  bersaglio.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, ...init }));
const rilascia = (bersaglio, init = {}) =>
  bersaglio.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, ...init }));

const totaleIstanze = () => Object.values(spie.perSessione).reduce((n, s) => n + s.istanze, 0);
const totaleSocket = () => Object.values(spie.perSessione).reduce((n, s) => n + s.socket, 0);

describe('doppia vista in orizzontale', () => {
  it('in orizzontale si affiancano: .nc-dual.row e maniglia verticale; in verticale torna com\'era', async () => {
    const vista = monta();
    await screen.findByTestId('pane-side');
    expect(document.querySelector('.nc-dual').className).not.toContain('row');
    expect(screen.getByTestId('dual-handle').getAttribute('aria-orientation')).toBe('horizontal');

    ruota(true);
    await waitFor(() => { expect(document.querySelector('.nc-dual').className).toContain('row'); });
    expect(screen.getByTestId('dual-handle').getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getByTestId('pane-main').className).not.toContain('nascosto');
    expect(screen.getByTestId('pane-side').className).not.toContain('nascosto');

    ruota(false);
    await waitFor(() => { expect(document.querySelector('.nc-dual').className).not.toContain('row'); });
    expect(screen.getByTestId('dual-handle').getAttribute('aria-orientation')).toBe('horizontal');
    expect(vista).toBeTruthy();
  });

  // Soglia di «stretto» e maniglia calcolano la larghezza dai PESI: in
  // orizzontale i pannelli devono dividersi il box solo per peso (base 0),
  // non per contenuto — con la base automatica la striscia più ricca allarga
  // il suo pannello e la cella stretta resta sotto soglia senza scattare.
  // In verticale resta la disposizione di prima.
  it('in orizzontale i pannelli si dividono per peso (base 0); in verticale base invariata', async () => {
    monta();
    await screen.findByTestId('pane-side');
    expect(screen.getByTestId('pane-main').style.flexBasis).toBe('');
    expect(screen.getByTestId('pane-side').style.flexBasis).toBe('');

    ruota(true);
    await waitFor(() => { expect(document.querySelector('.nc-dual').className).toContain('row'); });
    expect(screen.getByTestId('pane-main').style.flexBasis).toBe('0px');
    expect(screen.getByTestId('pane-side').style.flexBasis).toBe('0px');

    ruota(false);
    await waitFor(() => { expect(document.querySelector('.nc-dual').className).not.toContain('row'); });
    expect(screen.getByTestId('pane-main').style.flexBasis).toBe('');
  });

  it('stretto sulla larghezza utile: box meno maniglia e bordi, non il box intero', async () => {
    // 820 px, pesi 1:1, font 17 (0,6 em = 10,2 px). Col box intero:
    // 820 / 2 / 10,2 = 40,2 colonne, NON stretto. Larghezza utile:
    // (820 − 12) / 2 − 26 (bordi, padding, barra di xterm) = 378 px
    // → 37 colonne: stretto, come le colonne vere del terminale.
    localStorage.setItem('nc_fontsize', '17');
    const prima = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 820 });
    try {
      ruota(true);
      monta();
      await screen.findByTestId('pane-main');
      await waitFor(() => { expect(screen.getByTestId('pane-side').className).toContain('nascosto'); });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: prima });
    }
  });

  it('senza seconda cella nessuna misura del carattere nel DOM (come prima)', async () => {
    const aggiunte = [];
    const originale = document.body.appendChild.bind(document.body);
    document.body.appendChild = (n) => { aggiunte.push(n.tagName); return originale(n); };
    try {
      ruota(true);
      render(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />);
      await screen.findByTestId('term');
      localStorage.setItem('nc_fontsize', '17');
      ruota(false); ruota(true);
      await waitFor(() => { expect(document.querySelector('.nc-dual')).toBeNull(); });
    } finally {
      document.body.appendChild = originale;
    }
    expect(aggiunte.filter((t) => t === 'SPAN')).toEqual([]);
  });

  it('i pesi sono separati: il drag in orizzontale non tocca le altezze del verticale', async () => {
    monta();
    await screen.findByTestId('pane-side');
    const maniglia = screen.getByTestId('dual-handle');
    const crescita = () => screen.getByTestId('pane-main').style.flexGrow;

    // drag VERTICALE: il pannello superiore si allarga (confine che segue il
    // dito). jsdom non ha PointerEvent: le COORDINATE viaggiano con un
    // MouseEvent vero (clientY), che il listener su window legge.
    premici(maniglia, { clientY: 100 });
    muovici(window, { clientY: 220 });
    rilascia(window);
    // il setState del listener nativo si scarica in microtask: lo aspetto
    await waitFor(() => { expect(Number(crescita())).toBeGreaterThan(1); });
    const crescitaVerticale = crescita();

    // in orizzontale i pesi H ripartono da 1:1, e il drag orizzontale segue il dito
    ruota(true);
    await waitFor(() => {
      expect(document.querySelector('.nc-dual').className).toContain('row');
      expect(Number(crescita())).toBe(1);
    });
    premici(maniglia, { clientX: 300 });
    muovici(window, { clientX: 500 });
    rilascia(window);
    await waitFor(() => { expect(Number(crescita())).toBeGreaterThan(1); });

    // tornando in verticale: le altezze di prima
    ruota(false);
    await waitFor(() => {
      expect(document.querySelector('.nc-dual').className).not.toContain('row');
      expect(crescita()).toBe(crescitaVerticale);
    });
  });

  it('stretto: solo la cella col focus, tasto-icona per passare all\'altra, input alla visibile', async () => {
    localStorage.setItem('nc_fontsize', '24'); // 512 px / (24×0.6) ≈ 35 colonne < 40
    ruota(true);
    monta();
    await screen.findByTestId('pane-main');

    // il pannello senza focus è nascosto (montato, display none), niente maniglia
    expect(screen.getByTestId('pane-side').className).toContain('nascosto');
    expect(screen.getByTestId('pane-side').style.flexGrow).toBeTruthy();
    expect(screen.queryByTestId('dual-handle')).toBeNull();
    const primaIstanze = totaleIstanze();
    const primaSocket = totaleSocket();

    // il tasto-icona nella striscia della cella visibile porta all'altra
    const tasto = within(screen.getByTestId('pane-main')).getByTitle('dual-go-to');
    expect(tasto.getAttribute('aria-label')).toBe('dual-go-to');
    expect(tasto.closest('[data-testid="pane-main"]')).toBeTruthy();
    // e il tasto esiste anche nella striscia dell'altra (nascosta): stessa via
    expect(within(screen.getByTestId('pane-side')).getByTitle('dual-go-to')).toBeTruthy();
    fireEvent.click(tasto);

    await waitFor(() => {
      expect(screen.getByTestId('pane-side').className).not.toContain('nascosto');
      expect(screen.getByTestId('pane-main').className).toContain('nascosto');
    });
    // il focus (e quindi l'input) è passsato alla cella ora visibile
    expect(spie.perSessione['cloud-Fork'].props.focused).toBe(true);
    expect(spie.perSessione['cloud-Dev'].props.focused).toBe(false);
    // il passaggio NON ha montato né riconnesso nessun terminale
    expect(totaleIstanze()).toBe(primaIstanze);
    expect(totaleSocket()).toBe(primaSocket);
    fireEvent.click(screen.getByTestId('kb-kb'));
    fireEvent.click(await screen.findByTestId('invio'));
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual(['ping']);
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual([]);
  });

  it('rotazioni avanti e indietro: focus e altezze conservati, zero terminali ricreati', async () => {
    monta();
    await screen.findByTestId('pane-side');
    // focus alla seconda e drag verticale: il punto di partenza del giro
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    const maniglia = screen.getByTestId('dual-handle');
    premici(maniglia, { clientY: 100 });
    muovici(window, { clientY: 240 });
    rilascia(window);
    await waitFor(() => { expect(Number(screen.getByTestId('pane-main').style.flexGrow)).toBeGreaterThan(1); });
    const pesoMainVerticale = screen.getByTestId('pane-main').style.flexGrow;
    const istanzeAlGiro = totaleIstanze();
    const socketAlGiro = totaleSocket();

    ruota(true);
    await waitFor(() => { expect(document.querySelector('.nc-dual').className).toContain('row'); });
    ruota(false);
    await waitFor(() => {
      expect(document.querySelector('.nc-dual').className).not.toContain('row');
      expect(screen.getByTestId('pane-main').style.flexGrow).toBe(pesoMainVerticale);
    });
    expect(screen.getByTestId('pane-side').className).toContain('foco');
    expect(spie.perSessione['cloud-Fork'].props.focused).toBe(true);
    expect(totaleIstanze()).toBe(istanzeAlGiro);
    expect(totaleSocket()).toBe(socketAlGiro);
  });

  it('in verticale stretto non esiste: il font grande non nasconde nulla', async () => {
    localStorage.setItem('nc_fontsize', '24');
    monta();
    await screen.findByTestId('pane-side');
    expect(document.querySelector('.nc-dual').className).not.toContain('row');
    expect(screen.getByTestId('pane-main').className).not.toContain('nascosto');
    expect(screen.getByTestId('dual-handle')).toBeTruthy();
  });
});
