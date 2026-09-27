import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// barra alta della vista singola.
//
// Cosa presidia: la barra espone SOLO −, + e ⋯ (le altre quattro azioni vivono
// nel menu), ogni voce del menu mostra il proprio stato on/off, la voce
// «Pannello» esiste solo se la cella pubblica un panelUrl, e il sottotitolo ha
// il contratto di troncamento che oggi non ha.
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

import { SingleView, leggiFilesTasto } from './App.jsx';
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

describe('barra alta: solo −, + e ⋯', () => {
  it('le quattro azioni non stanno piu\' in fila nella barra', async () => {
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('zoom-out'))).toBeTruthy(); });

    // Restano: −, + e il ⋯.
    expect(screen.getByTitle(t('zoom-in'))).toBeTruthy();
    expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy();

    // Non stanno piu' nella barra: sono nel menu.
    expect(screen.queryByTitle(t('composer'))).toBeNull();
    expect(screen.queryByTitle(t('files'))).toBeNull();
    expect(screen.queryByTitle(t('panel'))).toBeNull();
    expect(document.querySelector('.nc-renderer-toggle')).toBeNull();
  });

  // La voce si cerca per `data-cellaction`, non per testo: col sottotitolo il
  // testo accessibile non e' piu' la sola etichetta.
  const voce = (menu, id) => within(menu).getAllByRole('menuitemcheckbox')
    .find((v) => v.dataset.cellaction === id);

  it('il menu ⋯ contiene le quattro voci, con il loro stato vero', async () => {
    apri();
    const menu = await apriMenu();
    const voci = within(menu).getAllByRole('menuitemcheckbox');
    expect(voci.map((v) => v.dataset.cellaction))
      .toEqual(['keyboard', 'files', 'panel', 'renderer']);
    // Stato iniziale misurato, non dedotto: composer chiuso (pointer fine nei
    // test), file chiusi, pannello chiuso, renderer WebGL (default senza
    // preferenza scritta).
    expect(voce(menu, 'keyboard').getAttribute('aria-checked')).toBe('false');
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('false');
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
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(voce(menu, 'files'));
    menu = await apriMenu();
    expect(voce(menu, 'files').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(voce(menu, 'panel'));
    menu = await apriMenu();
    expect(voce(menu, 'panel').getAttribute('aria-checked')).toBe('true');
  });

  it('il renderer parte dalla preferenza scritta, non da un default', async () => {
    // Il renderer e' l'unica voce il cui tocco esce dal menu: scrive la
    // preferenza e RICARICA la pagina. jsdom non naviga (e non lo si puo'
    // stubbare in modo affidabile), quindi qui si verifica che la voce mostri
    // lo stato scritto; il tocco con ricaricamento si prova dal vivo.
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

// Il tasto dei file della barra (mobile): è un'IMPOSTAZIONE per dispositivo.
// La voce «Cell files» del menu accende/spegne il TASTO, non apre la lista;
// il tasto, quando c'è, apre e chiude la lista della cella col focus e resta
// in barra finché l'impostazione lo dice. Desktop: nulla di nuovo.
describe('tasto file della barra (impostazione mobile)', () => {
  const tastoFiles = () => screen.queryByTitle(t('bar-menu-files'));
  const ordineBarra = () =>
    [...document.querySelectorAll('.nc-bar-right button')].map((b) => b.getAttribute('title'));

  it('senza impostazione il tasto non esiste e la voce del menu NON apre la lista', async () => {
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
    expect(tastoFiles()).toBeNull();
    expect(screen.queryByTestId('files-panel')).toBeNull();

    const menu = await apriMenu();
    const voceFiles = within(menu).getAllByRole('menuitemcheckbox').find((v) => v.dataset.cellaction === 'files');
    expect(voceFiles.getAttribute('aria-checked')).toBe('false');
    expect(voceFiles.querySelector('.nc-cellactions-desc').textContent)
      .toBe(t('bar-menu-files-setting-desc'));
    fireEvent.click(voceFiles);

    // accendere l'impostazione mostra il TASTO, non il pannello
    expect(screen.queryByTestId('files-panel')).toBeNull();
    await waitFor(() => { expect(tastoFiles()).toBeTruthy(); });
    expect(leggiFilesTasto()).toBe(true);
  });

  it('con l\'impostazione accesa il tasto apre e chiude la lista della cella col focus', async () => {
    localStorage.setItem('nc_bar_files_button', 'on');
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

  it('l\'impostazione persiste: il tasto resta dopo il rimontaggio, e torna via spegnendola', async () => {
    localStorage.setItem('nc_bar_files_button', 'on');
    const prima = apri();
    await waitFor(() => { expect(tastoFiles()).toBeTruthy(); });
    prima.unmount();

    const dopo = apri();
    await waitFor(() => { expect(tastoFiles()).toBeTruthy(); });
    dopo.unmount();

    localStorage.setItem('nc_bar_files_button', 'off');
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
    expect(tastoFiles()).toBeNull();
  });

  it('ordine dei tasti in barra: −, +, cartella (se attiva), ⋯ — nessun altro posto', async () => {
    localStorage.setItem('nc_bar_files_button', 'on');
    apri();
    await waitFor(() => { expect(tastoFiles()).toBeTruthy(); });
    expect(ordineBarra()).toEqual([
      t('zoom-out'), t('zoom-in'), t('bar-menu-files'), t('bar-menu-open'),
    ]);
  });

  it('in doppia vista il tasto serve la cella col focus', async () => {
    localStorage.setItem('nc_bar_files_button', 'on');
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()}
      side={{ session: 'cloud-SideCell' }} onSideClose={vi.fn()} onSideGone={vi.fn()} />);
    const tasto = await waitFor(() => { const b = tastoFiles(); expect(b).toBeTruthy(); return b; });

    // focus sulla cella principale (default): la lista è la sua
    fireEvent.click(tasto);
    expect((await screen.findByTestId('files-panel')).dataset.session).toBe('cloud-AIDesktopCell');
    fireEvent.click(tastoFiles());
    expect(screen.queryByTestId('files-panel')).toBeNull();

    // il tocco sul pannello secondario sposta il focus: la lista diventa la sua
    fireEvent.pointerDown(screen.getByTestId('pane-side'));
    fireEvent.click(tastoFiles());
    expect((await screen.findByTestId('files-panel')).dataset.session).toBe('cloud-SideCell');
  });

  it('desktop: nessun tasto nuovo anche con l\'impostazione accesa, e la voce apre la lista come prima', async () => {
    const veroMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    try {
      localStorage.setItem('nc_bar_files_button', 'on');
      apri();
      await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
      expect(tastoFiles()).toBeNull();

      const menu = await apriMenu();
      const voceFiles = within(menu).getAllByRole('menuitemcheckbox').find((v) => v.dataset.cellaction === 'files');
      expect(voceFiles.querySelector('.nc-cellactions-desc').textContent).toBe(t('bar-menu-files-desc'));
      fireEvent.click(voceFiles);
      expect(await screen.findByTestId('files-panel')).toBeTruthy();
    } finally {
      window.matchMedia = veroMatchMedia;
    }
  });
});
