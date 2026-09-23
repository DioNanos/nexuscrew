import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';

// geometria e stato della RIGA della lista celle (CellSwitcher).
//
// Cosa presidia: la riga ha altezza fissa e ritaglia (il contenuto non esce,
// quindi il tocco resta dentro la riga), mostra UNO stato solo da una sola
// fonte (mai «idle» e «stopped» insieme) e non ripete piu' il nodeLabel, che
// sale una volta sola nell'intestazione del gruppo.
//
// Cosa NON presidia: il gesto di apertura (per decisione di DAG il tocco
// seleziona, il secondo apre: fuori da questo mandato) e la cascata CSS reale.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" data-session={props.session} /> }));
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
