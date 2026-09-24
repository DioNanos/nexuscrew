import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// geometria e stato della RIGA della lista celle (CellSwitcher).
//
// Cosa presidia: la riga ha altezza fissa e ritaglia (il contenuto non esce,
// quindi il tocco resta dentro la riga), mostra UNO stato solo da una sola
// fonte (mai «idle» e «stopped» insieme) e non ripete piu' il nodeLabel, che
// sale una volta sola nell'intestazione del gruppo.
//
// Cosa NON presidia: la cascata CSS reale (jsdom non la calcola). Il gesto di
// apertura — un tocco seleziona, il secondo apre — e' presidiato qui sotto
// nel suo describe.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
vi.mock('./Terminal.jsx', () => ({ default: (props) => (
  <div data-testid="peek-term" data-session={props.session}
    data-fontsize={props.fontSize} data-readonly={String(!!props.readonly)} />
) }));
vi.mock('./CellPanel.jsx', () => ({
  default: (props) => (
    <div data-testid="peek-panel" data-cell={props.cellId} data-panel-port={props.panelPort} data-route={JSON.stringify(props.route)} />
  ),
}));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { t } from '../lib/i18n.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
  mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
  mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [] }));
});

describe('la riga ha uno stato solo', () => {
  // Il caso che produceva il difetto: il poll conferma la cella viva e il suo
  // hook pubblica `stato: 'ferma'`. Prima la riga mostrava «idle» E «stopped»
  // insieme; ora una sola fonte parla. Il poll riscrive la lista, quindi le
  // risposte devono restituire le STESSE celle, o la riga sparisce sotto
  // l'assert e il test verificherebbe un nodo staccato.
  const sessione = () => ({ name: 'cloud-cell-One', activity: Date.now() - 120000, working: false, attivita: { stato: 'ferma' } });
  beforeEach(() => {
    writeCellSwitcherSnapshot({
      sessions: [sessione()], cells: [active('cell-One', 'cloud-cell-One')],
      localFresh: true, nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [sessione()] }) });
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
  });

  it('cella viva con l\'hook che dichiara «ferma»: la riga dice «in attesa», non «stopped»', async () => {
    render(<Switcher />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });

    expect(riga.querySelector('.nc-cell-switcher-state').textContent).toBe(t('cell-idle'));
    expect(riga.textContent).not.toContain(t('cell-stopped'));
    expect(riga.textContent).not.toContain(t('cell-working'));
  });

  it('lo stato e la sua riga restano UNO: il vecchio sottotitolo non e\' piu\' una seconda riga', async () => {
    render(<Switcher />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    const copy = riga.querySelector('.nc-cell-switcher-copy');
    // Due testi: il nome e UNA riga di stato. Non tre.
    expect(copy.querySelectorAll('b')).toHaveLength(1);
    expect(copy.querySelectorAll('.nc-cell-switcher-stateline')).toHaveLength(1);
  });
});

describe('il nodeLabel sale nell\'intestazione del gruppo', () => {
  it('il gruppo LOCALE si chiama come il nodo (localNodeLabel), non «locale»', async () => {
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-cell-One', activity: Date.now() - 60000, working: false }],
      cells: [active('cell-One', 'cloud-cell-One')],
      localFresh: true, nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: Date.now() - 60000, working: false }],
    }) });
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
    render(<Switcher localNodeLabel="VPSCloud" />);
    await screen.findByRole('button', { name: /^cell-One / });
    const teste = [...document.querySelectorAll('.nc-cell-switcher-position')];
    expect(teste).toHaveLength(1);
    expect(teste[0].textContent).toBe(t('cell-switcher-group').replace('{node}', 'VPSCloud'));
  });

  it('senza localNodeLabel il gruppo locale resta «locale»', async () => {
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-cell-One', activity: Date.now() - 60000, working: false }],
      cells: [active('cell-One', 'cloud-cell-One')],
      localFresh: true, nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: Date.now() - 60000, working: false }],
    }) });
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
    render(<Switcher />);
    await screen.findByRole('button', { name: /^cell-One / });
    const teste = [...document.querySelectorAll('.nc-cell-switcher-position')];
    expect(teste[0].textContent).toBe(t('cell-switcher-group').replace('{node}', t('cell-switcher-group-local')));
  });

  it('VPSCloud compare una volta in testa, non su ogni riga', async () => {
    writeCellSwitcherSnapshot({
      sessions: [],
      cells: [],
      localFresh: true,
      nodeGroups: [{
        route: ['hub'], label: 'VPSCloud', switcherFresh: true,
        sessions: [{ name: 'cloud-Remote', activity: Date.now() - 60000, working: false }],
        cells: [active('Remote', 'cloud-Remote')],
      }],
    });
    // Il poll riscrive il gruppo: senza queste risposte il refresh lo svuota e
    // la riga sparisce sotto l'assert.
    mocks.getRouteSessions.mockResolvedValue({
      sessions: [{ name: 'cloud-Remote', activity: Date.now() - 60000, working: false }],
    });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: [active('Remote', 'cloud-Remote')] }
      : { available: true, cells: [] }));
    render(<Switcher />);
    const riga = await screen.findByRole('button', { name: /^Remote / });

    // Nessuna riga porta l'etichetta del nodo.
    expect(riga.textContent).not.toContain('VPSCloud');
    // L'intestazione del gruppo la porta, una volta sola.
    const teste = [...document.querySelectorAll('.nc-cell-switcher-position')];
    expect(teste).toHaveLength(1);
    expect(teste[0].textContent).toBe(t('cell-switcher-group').replace('{node}', 'VPSCloud'));
  });
});

describe('il gesto della lista: un tocco seleziona, il secondo apre', () => {
  // Due celle locali vive: il gesto si prova su tutte e due (selezione,
  // spostamento, apertura).
  const sessioni = () => ([
    { name: 'cloud-cell-One', activity: Date.now() - 60000, working: false },
    { name: 'cloud-cell-Two', activity: Date.now() - 60000, working: false },
  ]);
  beforeEach(() => {
    writeCellSwitcherSnapshot({
      sessions: sessioni(),
      cells: [active('cell-One', 'cloud-cell-One'), active('cell-Two', 'cloud-cell-Two')],
      localFresh: true, nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: sessioni() }) });
    mocks.fleetStatus.mockImplementation(async () => ({
      available: true,
      cells: [active('cell-One', 'cloud-cell-One'), active('cell-Two', 'cloud-cell-Two')],
    }));
  });

  it('senza selezione, la riga d\'aiuto dice il gesto', async () => {
    render(<Switcher />);
    await screen.findByRole('button', { name: /^cell-One / });
    expect(screen.getByText(t('cell-switcher-tap-hint'))).toBeTruthy();
  });

  it('primo tocco: seleziona la riga e apre l\'anteprima, NON apre la cella', async () => {
    const onPick = vi.fn();
    render(<Switcher onPick={onPick} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    expect(screen.queryByTestId('cell-switcher-anteprima')).toBeNull();
    fireEvent.click(riga);
    expect(await screen.findByTestId('cell-switcher-anteprima')).toBeTruthy();
    expect(riga.getAttribute('data-selected')).toBe('true');
    expect(riga.textContent).toContain(t('cell-switcher-two-taps'));
    expect(onPick).not.toHaveBeenCalled();
    // col gesto in corso, la riga d'aiuto non serve piu'.
    expect(screen.queryByText(t('cell-switcher-tap-hint'))).toBeNull();
  });

  it('secondo tocco sulla STESSA riga: apre, col ricontrollo fresco', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<Switcher onPick={onPick} onClose={onClose} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(riga);
    fireEvent.click(riga);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-cell-One', cellName: 'cell-One' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('tocco su un\'ALTRA riga: la selezione si sposta, non si apre niente', async () => {
    const onPick = vi.fn();
    render(<Switcher onPick={onPick} />);
    const una = await screen.findByRole('button', { name: /^cell-One / });
    const due = screen.getByRole('button', { name: /^cell-Two / });
    fireEvent.click(una);
    expect(await screen.findByTestId('cell-switcher-anteprima')).toBeTruthy();
    fireEvent.click(due);
    expect(una.getAttribute('data-selected')).toBeNull();
    expect(due.getAttribute('data-selected')).toBe('true');
    // l'anteprima ora e' dell'ALTRA cella
    const term = screen.getByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('cloud-cell-Two');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('uno scroll non e\' un tocco: il dito che si muove non seleziona e non apre', async () => {
    const onPick = vi.fn();
    render(<Switcher onPick={onPick} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    // Il dito scende lungo la lista e MOLLA sopra la riga: e' uno scroll, il
    // click che ne segue non conta. Il click di un puntatore vero porta
    // detail>=1: detail 0 e' l'attivazione da tastiera, un'altra cosa.
    fireEvent.pointerDown(riga, { clientX: 20, clientY: 100 });
    fireEvent.pointerMove(riga, { clientX: 20, clientY: 240 });
    fireEvent.pointerUp(riga, { clientX: 20, clientY: 240 });
    fireEvent.click(riga, { clientX: 20, clientY: 240, detail: 1 });
    expect(screen.queryByTestId('cell-switcher-anteprima')).toBeNull();
    expect(riga.getAttribute('data-selected')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('l\'anteprima usa lo stesso font del terminale principale (nc_fontsize), in sola lettura', async () => {
    localStorage.setItem('nc_fontsize', '17');
    render(<Switcher />);
    fireEvent.click(await screen.findByRole('button', { name: /^cell-One / }));
    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-fontsize')).toBe('17');
    expect(term.getAttribute('data-readonly')).toBe('true');
    // Il + dell'anteprima muove lo STESSO valore: la chiave e' una sola.
    fireEvent.click(screen.getByTitle(t('zoom-in')));
    expect((await screen.findByTestId('cell-switcher-fontsize')).textContent).toBe('18 px');
    expect(localStorage.getItem('nc_fontsize')).toBe('18');
  });
});

describe('contratto CSS della riga', () => {
  const percorsi = ['src/components/CellSwitcher.css', 'frontend/src/components/CellSwitcher.css']
    .map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p));
  const css = readFileSync(percorsi, 'utf8');

  function regola(selettore) {
    const i = css.indexOf(`${selettore} {`);
    if (i < 0) return '';
    return css.slice(i, css.indexOf('}', i));
  }

  it('la riga ha altezza fissa e ritaglia il contenuto', () => {
    const r = regola('.nc-cell-switcher-row');
    expect(r).not.toBe('');
    expect(r).toMatch(/height:\s*60px/);
    expect(r).toMatch(/overflow:\s*hidden/);
  });
});

function Switcher(props) {
  return <CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} {...props} />;
}
