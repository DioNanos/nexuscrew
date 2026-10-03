import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Doppia vista nella singola mobile: la garanzia centrale è che l'input di
// una cella non finisca MAI nell'altra. Il mock di Terminal è la spia sui
// due canali: ogni sessione ha le sue paste (composer), i suoi tasti
// (KeyBar) e le sue azioni; le props dichiarative (focused/readonly/takeSize)
// vengono registrate a ogni render.
const fixture = vi.hoisted(() => ({ sessions: {}, cells: {} }));
const spie = vi.hoisted(() => ({ perSessione: {} }));

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
    // Replica il contratto di connessione del vero terminale: l'effetto che
    // crea e distrugge terminale+socket dipende da queste props (lo stesso
    // elenco di Terminal.jsx, ridotto alle prop che possono cambiare identità
    // da un render all'altro: le primitive e le CALLBACK). Se una cambia, la
    // "connessione" riparte.
    React.useEffect(() => {
      spia.socket += 1;
    }, [session, readonly, takeSize, onFiles]);
    // Istanze: un terminale creato per montaggio del componente.
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
  default: ({ send, action, onKeyboard }) => (
    <div>
      <button data-testid="kb-kb" onClick={onKeyboard}>kb</button>
      <button data-testid="kb-send" onClick={() => send('ESC')}>send</button>
      <button data-testid="kb-action" onClick={() => action('copy')}>act</button>
    </div>
  ),
}));
vi.mock('./ComposerBar.jsx', () => ({
  default: ({ submitText, session }) => (
    <button data-testid="invio" data-target={session} onClick={() => submitText('ping')}>invia</button>
  ),
}));
vi.mock('./FilesPanel.jsx', () => ({
  default: ({ session }) => <div data-testid="files" data-files-session={session} />,
}));
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
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    });
  }
});

beforeEach(() => {
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

function monta(props = {}) {
  return render(
    <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()}
      side={{ session: 'cloud-Fork' }}
      onSideClose={props.onSideClose ?? vi.fn()} onSideGone={props.onSideGone ?? vi.fn()}
      {...props} />,
  );
}

async function apriComposer() {
  fireEvent.click(screen.getByTestId('kb-kb'));
  await screen.findByTestId('invio');
}

describe('doppia vista: l’input va solo alla cella col focus', () => {
  it('focus iniziale sulla cella aperta: l’invio finisce solo lì', async () => {
    monta();
    await apriComposer();
    fireEvent.click(screen.getByTestId('invio'));
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual(['ping']);
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual([]);
  });

  it('cambio focus col tocco e invio immediato: il testo va al nuovo focus', async () => {
    monta();
    await apriComposer();
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(screen.getByTestId('invio'));
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual(['ping']);
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual([]);
    // la barra dichiarazione del bersaglio segue il focus
    expect(screen.getByTestId('invio').getAttribute('data-target')).toBe('cloud-Fork');
  });

  it('tasti KeyBar (ESC) e azioni: solo al pannello col focus', async () => {
    monta();
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(screen.getByTestId('kb-send'));
    fireEvent.click(screen.getByTestId('kb-action'));
    expect(spie.perSessione['cloud-Fork'].keys).toEqual(['ESC']);
    expect(spie.perSessione['cloud-Fork'].actions).toEqual(['copy']);
    expect(spie.perSessione['cloud-Dev'].keys).toEqual([]);
    expect(spie.perSessione['cloud-Dev'].actions).toEqual([]);
  });

  it('il size-lock resta alla cella aperta; il focus non tocca readonly', async () => {
    monta();
    await waitFor(() => {
      expect(spie.perSessione['cloud-Dev'].props.takeSize).toBe(true);
      expect(spie.perSessione['cloud-Fork'].props.takeSize).toBe(false);
    });
    expect(spie.perSessione['cloud-Dev'].props.focused).toBe(true);
    // focus alla seconda: l'input la raggiunge, ma il size-lock non si muove
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    expect(spie.perSessione['cloud-Fork'].props.focused).toBe(true);
    expect(spie.perSessione['cloud-Dev'].props.focused).toBe(false);
    expect(spie.perSessione['cloud-Dev'].props.takeSize).toBe(true);
    expect(spie.perSessione['cloud-Fork'].props.takeSize).toBe(false);
  });

  it('tre cambi di focus non ricreano terminali né connessioni; l’invio segue sempre il focus', async () => {
    monta();
    await waitFor(() => {
      expect(spie.perSessione['cloud-Dev'].socket).toBe(1);
      expect(spie.perSessione['cloud-Fork'].socket).toBe(1);
    });
    await apriComposer();
    // cambio 1 → side
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(screen.getByTestId('invio'));
    // cambio 2 → aperta
    fireEvent.pointerDown(screen.getByTestId('pane-main'));
    fireEvent.click(screen.getByTestId('invio'));
    // cambio 3 → side
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(screen.getByTestId('invio'));
    // gli invii sono andati tutti e soli al pannello col focus di quel momento
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual(['ping', 'ping']);
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual(['ping']);
    // nessuna riconnessione: due terminali, due connessioni, fermi
    expect(spie.perSessione['cloud-Dev'].socket).toBe(1);
    expect(spie.perSessione['cloud-Fork'].socket).toBe(1);
    expect(screen.getAllByTestId('term')).toHaveLength(2);
  });

  it('re-render non correlati: 1 terminale/connessione in singola, 2 in doppia', async () => {
    // SINGOLA: tre re-render con props non correlate (onBack nuovo a ogni giro)
    // non devono creare né terminali né connessioni nuove.
    const singola = render(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />);
    await waitFor(() => expect(spie.perSessione['cloud-Dev'].socket).toBe(1));
    for (let i = 0; i < 3; i += 1) {
      singola.rerender(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={() => {}} />);
    }
    expect(spie.perSessione['cloud-Dev'].socket).toBe(1);
    expect(spie.perSessione['cloud-Dev'].istanze).toBe(1);
    expect(screen.getAllByTestId('term')).toHaveLength(1);
    singola.unmount();

    // DOPPIA: montaggio a parte con spie da zero — il passaggio singola→doppia
    // cambia la STRUTTURA (rimonta il pannello principale) e non è un re-render.
    spie.perSessione = {};
    const doppia = render(
      <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={() => {}}
        side={{ session: 'cloud-Fork' }} onSideClose={vi.fn()} onSideGone={vi.fn()} />,
    );
    await waitFor(() => {
      expect(spie.perSessione['cloud-Dev'].socket).toBe(1);
      expect(spie.perSessione['cloud-Fork'].socket).toBe(1);
    });
    for (let i = 0; i < 3; i += 1) {
      doppia.rerender(
        <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={() => {}}
          side={{ session: 'cloud-Fork' }} onSideClose={vi.fn()} onSideGone={vi.fn()} />,
      );
    }
    expect(spie.perSessione['cloud-Dev'].socket).toBe(1);
    expect(spie.perSessione['cloud-Fork'].socket).toBe(1);
    expect(spie.perSessione['cloud-Dev'].istanze).toBe(1);
    expect(spie.perSessione['cloud-Fork'].istanze).toBe(1);
    expect(screen.getAllByTestId('term')).toHaveLength(2);
  });
});

describe('doppia vista: struttura e gestioni', () => {
  it('senza seconda cella il DOM è quello di oggi (vista singola, nessun dual)', () => {
    const { container } = render(
      <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />,
    );
    expect(screen.getAllByTestId('term')).toHaveLength(1);
    expect(container.querySelector('.nc-dual')).toBeNull();
    expect(container.querySelector('.nc-dual-handle')).toBeNull();
  });

  it('✕ chiude: callback una volta e ritorno esatto alla vista singola', async () => {
    const onSideClose = vi.fn();
    const view = monta({ onSideClose });
    expect(screen.getAllByTestId('term')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('dual-close'));
    expect(onSideClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()}
        side={null} onSideClose={onSideClose} onSideGone={vi.fn()} />,
    );
    expect(screen.getAllByTestId('term')).toHaveLength(1);
    expect(screen.queryByTestId('pane-side')).toBeNull();
    expect(screen.queryByTestId('dual-handle')).toBeNull();
    expect(screen.queryByLabelText('dual-swap')).toBeNull();
  });

  it('⇅ scambia le posizioni; le identità e il focus seguono le celle', async () => {
    const { container } = monta();
    await waitFor(() => {
      expect(spie.perSessione['cloud-Dev'].props.takeSize).toBe(true);
      expect(spie.perSessione['cloud-Fork'].props.takeSize).toBe(false);
    });
    const ordine = () => Array.from(container.querySelectorAll('.nc-dual-pane'))
      .map((n) => n.getAttribute('data-testid'));
    expect(ordine()).toEqual(['pane-main', 'pane-side']);
    expect(spie.perSessione['cloud-Dev'].props.focused).toBe(true);
    fireEvent.click(screen.getByLabelText('dual-swap'));
    expect(ordine()).toEqual(['pane-side', 'pane-main']);
    expect(screen.getByTestId('pane-main').querySelector('[data-term-session="cloud-Dev"]')).toBeTruthy();
    expect(screen.getByTestId('pane-side').querySelector('[data-term-session="cloud-Fork"]')).toBeTruthy();
    expect(spie.perSessione['cloud-Dev'].props.focused).toBe(true);
    // secondo tocco: si torna com’era
    fireEvent.click(screen.getByLabelText('dual-swap'));
    expect(ordine()).toEqual(['pane-main', 'pane-side']);
  });

  it('la seconda cella sparita (fonti autorevoli senza il nome) → onSideGone', async () => {
    fixture.sessions['/api'] = [{ name: 'cloud-Dev', activity: 0, attached: false, windows: 1 }];
    fixture.cells[''] = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' }];
    const onSideGone = vi.fn();
    monta({ onSideGone });
    await waitFor(() => expect(onSideGone).toHaveBeenCalledTimes(1));
  });

  it('la seconda cella presente: titolo nella striscia e nessun onSideGone', async () => {
    const onSideGone = vi.fn();
    monta({ onSideGone });
    await screen.findByText('Fork');
    await new Promise((r) => setTimeout(r, 0));
    expect(onSideGone).not.toHaveBeenCalled();
    expect(screen.getByTestId('pane-side').textContent).toContain('Fork');
  });
});

// La maniglia della doppia vista deve SEGUIRE IL DITO: il
// confine sale se trascino verso l'alto, scende se scendo, in entrambe le
// disposizioni (cella aperta sopra, o sotto dopo ⇅). I flexGrow sono la
// misura del confine: con contenitore 800px e pesi in somma 2, un confine
// a Y px mette Y/800*2 nel pannello sopra e il resto in quello sotto.
// Minimo 0.2: nessun pannello collassa anche trascinando fuori dallo schermo.
describe('doppia vista: la maniglia segue il dito', () => {
  function prepara(container, altezza = 800) {
    const box = container.querySelector('.nc-dual');
    Object.defineProperty(box, 'clientHeight', { value: altezza, configurable: true });
    // jsdom non porta clientY negli eventi pointer sintetici (resta null e
    // l'aritmetica della maniglia collasserebbe a 0): eventi costruiti a mano
    // con le coordinate stabilite.
    const evento = (type, props) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
      return e;
    };
    return {
      flex: () => ({
        main: container.querySelector('[data-testid="pane-main"]').style.flexGrow,
        side: container.querySelector('[data-testid="pane-side"]').style.flexGrow,
      }),
      trascina: (da, a) => {
        fireEvent(screen.getByTestId('dual-handle'), evento('pointerdown', { clientY: da }));
        fireEvent(window, evento('pointermove', { clientY: a }));
        fireEvent(window, evento('pointerup', {}));
      },
    };
  }

  it('cella aperta sopra: su 100px -> confine a 300 (main 0.75 / side 1.25); poi giù -> confine segue', async () => {
    const { container } = monta();
    await waitFor(() => expect(spie.perSessione['cloud-Fork'].props.takeSize).toBe(false));
    const { flex, trascina } = prepara(container);
    expect(flex()).toEqual({ main: '1', side: '1' });
    // trascino dalla maniglia (400) verso l'alto fino a 300: il confine SALE
    // (il listener è nativo su window: il re-render è asincrono, si aspetta)
    trascina(400, 300);
    await waitFor(() => expect(flex()).toEqual({ main: '0.75', side: '1.25' }));
    // e viceversa: da 300 giù fino a 500: il confine SCENDE col dito
    trascina(300, 500);
    await waitFor(() => expect(flex()).toEqual({ main: '1.25', side: '0.75' }));
    // trascinando fuori dallo schermo nessun pannello collassa (min 0.2)
    trascina(500, -3000);
    await waitFor(() => expect(flex()).toEqual({ main: '0.2', side: '1.8' }));
  });

  it('dopo ⇅ (aperta sotto): su 100px -> il sopra (side) si restringe: side 0.75 / main 1.25', async () => {
    const { container } = monta();
    await waitFor(() => expect(spie.perSessione['cloud-Fork'].props.takeSize).toBe(false));
    const { flex, trascina } = prepara(container);
    fireEvent.click(screen.getByLabelText('dual-swap'));
    expect(flex()).toEqual({ main: '1', side: '1' });
    trascina(400, 300);
    await waitFor(() => expect(flex()).toEqual({ main: '1.25', side: '0.75' }));
    // e scendendo il sopra (side) si riallarga col dito
    trascina(300, 460);
    await waitFor(() => expect(flex()).toEqual({ main: '0.85', side: '1.15' }));
  });
});

// Dal rilievo che ha mosso la correzione: il focus può stare sulla seconda cella NEL
// momento in cui quella sparisce (✕ dell'operatore o onSideGone al poll).
// Lo stato del focus sopravvive un render — l'effetto che lo azzera gira
// DOPO — e in quel render nessuna espressione deve leggere side.* di un
// oggetto già null: la vista deve tornare singola, integra, con la barra
// che scrive nella cella principale.
describe('doppia vista: chiusura con il focus sulla seconda', () => {
  const tornaSingola = (view, extra = {}) => view.rerender(
    <SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()}
      side={null} onSideClose={vi.fn()} onSideGone={vi.fn()} {...extra} />,
  );

  it('✕ col focus sulla seconda: nessun crollo, vista singola e barra sull’aperta', async () => {
    const onSideClose = vi.fn();
    const view = monta({ onSideClose });
    await apriComposer();
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    expect(screen.getByTestId('invio').getAttribute('data-target')).toBe('cloud-Fork');
    fireEvent.click(screen.getByLabelText('dual-close'));
    expect(onSideClose).toHaveBeenCalledTimes(1);
    tornaSingola(view, { onSideClose });
    // il render di transizione (focus residuo, reset non ancora corso) non
    // deve smontare l'app: DOM vivo e un solo terminale, quello dell'aperta
    await waitFor(() => expect(screen.getAllByTestId('term')).toHaveLength(1));
    expect(screen.queryByTestId('pane-side')).toBeNull();
    expect(screen.getByTestId('term').getAttribute('data-term-session')).toBe('cloud-Dev');
    // la barra torna subito a scrivere nella cella principale
    expect(screen.getByTestId('invio').getAttribute('data-target')).toBe('cloud-Dev');
    fireEvent.click(screen.getByTestId('invio'));
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual(['ping']);
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual([]);
  });

  it('la seconda sparisce da sola (onSideGone) col focus su di lei: nessun crollo, barra sull’aperta', async () => {
    fixture.sessions['/api'] = [{ name: 'cloud-Dev', activity: 0, attached: false, windows: 1 }];
    fixture.cells[''] = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' }];
    const onSideGone = vi.fn();
    const view = monta({ onSideGone });
    await apriComposer();
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    expect(screen.getByTestId('invio').getAttribute('data-target')).toBe('cloud-Fork');
    await waitFor(() => expect(onSideGone).toHaveBeenCalledTimes(1));
    // il genitore risponde a onSideGone togliendo la side: questo render è quello del difetto
    tornaSingola(view, { onSideGone });
    await waitFor(() => expect(screen.getAllByTestId('term')).toHaveLength(1));
    expect(screen.getByTestId('invio').getAttribute('data-target')).toBe('cloud-Dev');
    fireEvent.click(screen.getByTestId('invio'));
    expect(spie.perSessione['cloud-Dev'].pastes).toEqual(['ping']);
    expect(spie.perSessione['cloud-Fork'].pastes).toEqual([]);
  });

  it('lista file della seconda aperta + ✕: nessun crollo e nessuna lista orfana', async () => {
    localStorage.setItem('nc_bar_files_button', 'on');
    const onSideClose = vi.fn();
    const view = monta({ onSideClose });
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    // il tasto cartella apre la lista della cella col focus: la seconda
    fireEvent.click(screen.getByLabelText('bar-menu-files'));
    expect(screen.getByTestId('files').getAttribute('data-files-session')).toBe('cloud-Fork');
    fireEvent.click(screen.getByLabelText('dual-close'));
    expect(onSideClose).toHaveBeenCalledTimes(1);
    tornaSingola(view, { onSideClose });
    await waitFor(() => expect(screen.getAllByTestId('term')).toHaveLength(1));
    expect(screen.getByTestId('term').getAttribute('data-term-session')).toBe('cloud-Dev');
    // la lista muore con la sua cella: nessun pannello sulla sessione sparita
    await waitFor(() => expect(screen.queryByTestId('files')).toBeNull());
  });
});
