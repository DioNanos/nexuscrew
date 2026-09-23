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
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
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
