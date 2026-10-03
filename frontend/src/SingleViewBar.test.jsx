import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// barra alta della vista singola — decisioni dell'operatore sulla PR #7.
//
// Cosa presidia: la barra espone −, +, i tasti DIRETTI cartella (icona
// disegnata della PR, non il download) e tastiera, il tasto AI Desktop SOLO
// con l'opzione accesa, e il menu ⋯ PER INTERO con i suoi quattro sottomenu
// (tastiera, file, pannello, renderer) come prima: i tasti diretti sono
// un'aggiunta, non una sostituzione.
//
// Cosa NON presidia: la cascata CSS reale (jsdom non la calcola). Il contratto
// sul foglio e' letto dal sorgente, come in SettingsPanelFleetMobile.test.js;
// la misura in browser resta a Dev.

const mocks = vi.hoisted(() => ({ fleetStatus: vi.fn() }));

vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: (props) => (
  <div data-testid="files-panel" data-session={props.session} data-node={props.node || ''} />
) }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({ default: () => null }));
vi.mock('./components/GridView.jsx', () => ({ default: () => null }));
vi.mock('./components/Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/PowerSheet.jsx', () => ({ default: () => null }));
vi.mock('./components/DeckBar.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', () => ({ default: () => null }));
vi.mock('./lib/api.js', () => ({
  apiFetch: vi.fn().mockRejectedValue(new Error('no network in test')),
  fleetStatus: mocks.fleetStatus,
  fleetUp: vi.fn(), fleetDown: vi.fn(), fleetBoot: vi.fn(),
  killSession: vi.fn(), getSettings: vi.fn(), nodeAction: vi.fn(),
  renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));

import { SingleView } from './App.jsx';
import { t } from './lib/i18n.js';

const cella = (panelUrl) => ({
  cell: 'AIDesktopCell', tmuxSession: 'cloud-AIDesktopCell',
  engine: 'claude.native', status: 'ferma', ...(panelUrl ? { panelUrl } : {}),
});

let ricarica;
beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  // switchRenderer ricarica la pagina: in jsdom la navigazione e' "not
  // implemented" e sporcherebbe l'output. Si sostituisce il solo metodo.
  ricarica = vi.fn();
  try {
    Object.defineProperty(window.location, 'reload', { configurable: true, value: ricarica });
  } catch (_) { /* location non ridefinibile in questo jsdom: si prosegue */ }
  mocks.fleetStatus.mockImplementation(async () => ({
    available: true, cells: [cella('https://127.0.0.1:6901/vnc.html')],
  }));
});

const apri = () => render(
  <SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />,
);

async function apriMenu() {
  await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
  fireEvent.click(screen.getByTitle(t('bar-menu-open')));
  return waitFor(() => screen.getByRole('menu'));
}

// La voce si cerca per `data-cellaction`, non per testo: col sottotitolo il
// testo accessibile non e' piu' la sola etichetta.
const voce = (menu, id) => within(menu).getAllByRole('menuitemcheckbox')
  .find((v) => v.dataset.cellaction === id);

describe('barra alta: −, +, cartella, tastiera, (AI Desktop) e menu ⋯', () => {
  it('cartella e tastiera sono in fila ACCESI di default; AI Desktop non c\'e\'', async () => {
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('zoom-out'))).toBeTruthy(); });
    expect(screen.getByTitle(t('zoom-in'))).toBeTruthy();
    expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy();
    expect(screen.getByTitle(t('bar-menu-keyboard'))).toBeTruthy();
    // AI Desktop: default spento, il tasto non esiste (la voce del menu resta).
    expect(screen.queryByTitle(t('bar-menu-panel'))).toBeNull();
    // Il menu ⋯ resta: trigger, ruolo e glifo.
    expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy();
    expect(document.querySelector('.nc-bar-menu')).toBeTruthy();
    expect(screen.getByText('⋯')).toBeTruthy();
  });

  it('il tasto file usa la CARTELLA disegnata della PR, non l\'icona download', async () => {
    apri();
    const file = await screen.findByTitle(t('bar-menu-files'));
    const d = file.querySelector('svg path')?.getAttribute('d') || '';
    // Il tratto della cartella in Icon.jsx («folder»): collo del bordo in alto
    // a sinistra. Il download comincia con la freccia «M12 4v10».
    expect(d.startsWith('M4 6a2 2 0 0 1 2-2h3.6')).toBe(true);
  });

  it('il tasto tastiera dichiara stato e nome accessibile, e commuta il composer', async () => {
    apri();
    const tastiera = await screen.findByTitle(t('bar-menu-keyboard'));
    expect(tastiera.getAttribute('aria-label')).toBe(t('bar-menu-keyboard'));
    expect(tastiera.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tastiera);
    await waitFor(() => {
      expect(screen.getByTitle(t('bar-menu-keyboard')).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('il menu ⋯ contiene le quattro voci, con il loro stato vero', async () => {
    apri();
    const menu = await apriMenu();
    const voci = within(menu).getAllByRole('menuitemcheckbox');
    expect(voci.map((v) => v.dataset.cellaction))
      .toEqual(['keyboard', 'files', 'panel', 'renderer']);
    // Stato iniziale misurato, non dedotto: composer chiuso (pointer fine nei
    // test), IMPOSTAZIONE del tasto file accesa (default nuovo), pannello
    // chiuso, renderer WebGL (default senza preferenza scritta).
    expect(voce(menu, 'keyboard').getAttribute('aria-checked')).toBe('false');
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('true');
    expect(voce(menu, 'panel').getAttribute('aria-checked')).toBe('false');
    expect(voce(menu, 'renderer').getAttribute('aria-checked')).toBe('true');
    // La sottoriga del design c'e' per ogni voce.
    expect(voce(menu, 'keyboard').querySelector('.nc-cellactions-desc').textContent)
      .toBe(t('bar-menu-keyboard-desc'));
    expect(voce(menu, 'renderer').querySelector('.nc-cellactions-desc').textContent)
      .toBe(t('bar-menu-renderer-desc'));
  });

  it('ogni voce cambia il proprio stato a ogni tocco', async () => {
    apri();
    // Il guscio condiviso (CellActions) chiude il menu dopo OGNI azione: lo
    // stato cambiato si osserva riaprendo. E' il comportamento che il menu ha
    // gia' per le azioni cella, non una scelta nuova di questa barra.
    let menu = await apriMenu();
    expect(voce(menu, 'keyboard').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(voce(menu, 'keyboard'));

    menu = await apriMenu();
    expect(voce(menu, 'keyboard').getAttribute('aria-checked')).toBe('true');
    // Su mobile la voce «files» e' l'IMPOSTAZIONE del tasto: accesa di
    // default, il tocco la spegne (e il tasto in barra sparisce).
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(voce(menu, 'files'));

    menu = await apriMenu();
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTitle(t('bar-menu-files'))).toBeNull();

    fireEvent.click(voce(menu, 'files'));
    menu = await apriMenu();
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy();

    fireEvent.click(voce(menu, 'panel'));
    menu = await apriMenu();
    expect(voce(menu, 'panel').getAttribute('aria-checked')).toBe('true');
  });

  it('il renderer parte dalla preferenza scritta, non da un default', async () => {
    localStorage.setItem('nc-terminal-renderer', 'dom');
    apri();
    const menu = await apriMenu();
    expect(voce(menu, 'renderer').getAttribute('aria-checked')).toBe('false');
  });

  it('senza panelUrl la voce Pannello non esiste (non e\' una voce spenta)', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    apri();
    const menu = await apriMenu();
    expect(voce(menu, 'panel')).toBeUndefined();
    expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(3);
  });
});

describe('contratto CSS del sottotitolo della barra', () => {
  const percorsi = ['src/App.css', 'frontend/src/App.css']
    .map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p));
  const css = readFileSync(percorsi, 'utf8');

  // Regola top-level con quel selettore esatto (il foglio e' in forma espansa).
  function regola(selettore) {
    const i = css.indexOf(`${selettore} {`);
    if (i < 0) return '';
    return css.slice(i, css.indexOf('}', i));
  }

  it('.nc-bar-sub tronca con ellipsis, come il titolo', () => {
    const r = regola('.nc-bar-sub');
    expect(r).not.toBe('');
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
    expect(r).toMatch(/white-space:\s*nowrap/);
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/max-width:\s*100%/);
  });
});

// I tre tasti diretti sono opzioni PER DISPOSITIVO (lib/bar-files-tasto.js):
// cartella e tastiera accesi di default, AI Desktop spento. Il default nuovo
// vale SOLO per chi non ha mai salvato la chiave: un valore gia' scritto
// ('on'/'off') si rispetta in entrambi i sensi.
describe('tasti diretti della barra (opzioni per dispositivo)', () => {
  const tastoFiles = () => screen.queryByTitle(t('bar-menu-files'));
  const tastoTastiera = () => screen.queryByTitle(t('bar-menu-keyboard'));
  const tastoPannello = () => screen.queryByTitle(t('bar-menu-panel'));
  const ordineBarra = () =>
    [...document.querySelectorAll('.nc-bar-right button')].map((b) => b.getAttribute('title'));

  it('valore gia\' salvato OFF: il tasto file non c\'e, anche col default nuovo acceso', async () => {
    localStorage.setItem('nc_bar_files_button', 'off');
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('zoom-out'))).toBeTruthy(); });
    await waitFor(() => { expect(mocks.fleetStatus).toHaveBeenCalled(); });
    expect(tastoFiles()).toBeNull();
  });

  it('valore gia\' salvato ON vale anche dove il default sarebbe spento (AI Desktop)', async () => {
    localStorage.setItem('nc_bar_panel_button', 'on');
    apri();
    const panel = await waitFor(() => { const b = tastoPannello(); expect(b).toBeTruthy(); return b; });
    expect(panel.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(panel);
    await waitFor(() => { expect(tastoPannello().getAttribute('aria-pressed')).toBe('true'); });
  });

  it('opzione tastiera OFF: il tasto tastiera sparisce, il menu resta', async () => {
    localStorage.setItem('nc_bar_keyboard_button', 'off');
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
    expect(tastoTastiera()).toBeNull();
    expect(tastoFiles()).toBeTruthy();
  });

  it('senza panelUrl il tasto AI Desktop non esiste nemmeno con l\'opzione accesa', async () => {
    localStorage.setItem('nc_bar_panel_button', 'on');
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    apri();
    await waitFor(() => { expect(tastoFiles()).toBeTruthy(); });
    expect(tastoPannello()).toBeNull();
  });

  it('il tasto file apre e chiude la lista della cella col focus', async () => {
    apri();
    const tasto = await waitFor(() => { const b = tastoFiles(); expect(b).toBeTruthy(); return b; });
    expect(tasto.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(tasto);
    const pannello = await screen.findByTestId('files-panel');
    expect(pannello.dataset.session).toBe('cloud-AIDesktopCell');
    expect(tastoFiles().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(tastoFiles());
    expect(screen.queryByTestId('files-panel')).toBeNull();
    expect(tastoFiles().getAttribute('aria-pressed')).toBe('false');
  });

  it('ordine dei tasti in barra: -, +, cartella, tastiera, (pannello), ⋯', async () => {
    localStorage.setItem('nc_bar_panel_button', 'on');
    apri();
    await waitFor(() => { expect(tastoPannello()).toBeTruthy(); });
    expect(ordineBarra()).toEqual([
      t('zoom-out'), t('zoom-in'), t('bar-menu-files'), t('bar-menu-keyboard'),
      t('bar-menu-panel'), t('bar-menu-open'),
    ]);
  });

  it('in doppia vista il tasto file serve la cella col focus', async () => {
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()}
      side={{ session: 'cloud-SideCell' }} onSideClose={vi.fn()} onSideGone={vi.fn()} />);
    const tasto = await waitFor(() => { const b = tastoFiles(); expect(b).toBeTruthy(); return b; });

    // focus sulla cella principale (default): la lista e' la sua
    fireEvent.click(tasto);
    expect((await screen.findByTestId('files-panel')).dataset.session).toBe('cloud-AIDesktopCell');
    fireEvent.click(tastoFiles());
    expect(screen.queryByTestId('files-panel')).toBeNull();

    // il tocco sul pannello secondario sposta il focus: la lista diventa la sua
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(tastoFiles());
    expect((await screen.findByTestId('files-panel')).dataset.session).toBe('cloud-SideCell');
  });
});
