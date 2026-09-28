import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// barra alta della vista singola.
//
// Cosa presidia: la barra espone −, +, il bottone file (icona download) e — solo
// se la cella pubblica un panelUrl — il bottone pannello (icona monitor). Il
// menu ⋯ non esiste piu': tastiera e renderer sono preferenze delle Impostazioni,
// file e pannello sono due bottoni in fila. Il sottotitolo ha il contratto di
// troncamento che oggi non ha.
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

describe('barra alta: −, +, file e (se c\'è) pannello', () => {
  it('le due azioni stanno in fila nella barra, e il menu ⋯ non esiste piu\'', async () => {
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('zoom-out'))).toBeTruthy(); });
    expect(screen.getByTitle(t('zoom-in'))).toBeTruthy();
    expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy();
    expect(screen.getByTitle(t('bar-menu-panel'))).toBeTruthy();
    // Nessun menu: ne' il trigger, ne' il ruolo, ne' il glifo.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('.nc-bar-menu')).toBeNull();
    expect(screen.queryByText('⋯')).toBeNull();
    // Tastiera e renderer non sono piu' azioni di barra (vivono nelle Impostazioni).
    expect(screen.queryByTitle(t('composer'))).toBeNull();
    expect(document.querySelector('.nc-renderer-toggle')).toBeNull();
  });

  it('il bottone file dichiara stato e nome accessibile, e apre il pannello file', async () => {
    apri();
    const file = await screen.findByTitle(t('bar-menu-files'));
    expect(file.getAttribute('aria-label')).toBe(t('bar-menu-files'));
    expect(file.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(file);
    await waitFor(() => {
      expect(screen.getByTitle(t('bar-menu-files')).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('il bottone pannello dichiara stato e apre il pannello della cella', async () => {
    apri();
    const panel = await screen.findByTitle(t('bar-menu-panel'));
    expect(panel.getAttribute('aria-label')).toBe(t('bar-menu-panel'));
    expect(panel.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(panel);
    await waitFor(() => {
      expect(screen.getByTitle(t('bar-menu-panel')).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('senza panelUrl il bottone pannello non esiste (non e\' un bottone spento)', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    apri();
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy(); });
    expect(screen.queryByTitle(t('bar-menu-panel'))).toBeNull();
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
