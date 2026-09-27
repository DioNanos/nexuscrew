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
