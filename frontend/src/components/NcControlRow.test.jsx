import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const fixture = vi.hoisted(() => ({ sessions: [], cells: [], nodes: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => ({
    json: async () => path === '/api/config'
      ? { version: '0.8.14', bind: '127.0.0.1', port: 41820, instanceId: 'c'.repeat(32) }
      : { sessions: fixture.sessions },
  })),
  seenKey: (session) => `nc_seen_${session}`,
  fleetStatus: vi.fn(async () => ({ available: true, capabilities: [], cells: fixture.cells })),
  fleetDefinitions: vi.fn(async () => ({ engines: [] })),
  fleetUp: vi.fn(async () => ({})),
  fleetDown: vi.fn(async () => ({})),
  fleetBoot: vi.fn(async () => ({})),
  killSession: vi.fn(async () => ({})),
  nodeAction: vi.fn(async () => ({})),
  renameNodeLabel: vi.fn(async () => ({})),
  setSessionTechnical: vi.fn(async () => ({})),
  getLiveHost: vi.fn(async () => ({ revision: 3, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(async () => ({ revision: 4, hostCell: null })),
  clearHostCell: vi.fn(async () => ({ revision: 5, hostCell: null })),
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" data-session={props.session} /> }));
vi.mock('./CellPanel.jsx', () => ({ default: (props) => <div data-testid="peek-panel" data-cell={props.cellId} /> }));

import SessionList from './SessionList.jsx';
import Sidebar from './Sidebar.jsx';
import { setLang, t } from '../lib/i18n.js';

// P3-2 — Dell'etichetta della supervisione NC in card resta solo ciò che
// chiede un'azione ADESSO: il controllo SCADUTO. Tutti gli altri esiti
// vivono nel foglio della cella (PowerSheet.test.jsx li prova per esteso):
// senza il binding persistito, dopo ogni riavvio del servizio l'etichetta
// perenne sarebbe rumore su ogni riga viva. Il testo di stato della riga
// (subtitle) resta il testo di STATO: presenza + turno, mai «NC» dentro.
const LINGUE = ['it', 'en', 'es'];

// Cella viva letta da un server VECCHIO: nessun campo ncControl.
const vivaSenzaCampo = (extra = {}) => ({
  cell: 'Dev Cell', tmuxSession: 'cloud-DevCell', tmux: true, active: true,
  engine: 'claude.native', key: '', ...extra,
});
// Sessione che dice solo «il titolo non prova nulla»: nessun turno qualificato.
const sessioneIncerta = (extra = {}) => ({
  name: 'cloud-DevCell', activity: 2, windows: 1, working: false, status: '', ...extra,
});

function rigaDi(testo, selettore) {
  return screen.getByText(testo).closest(selettore);
}

function proveRigaViva(row) {
  // 1. Lo stato della riga è la PRESENZA, esatta, nel suo elemento.
  expect(within(row).getByText(t('cell-present'))).toBeTruthy();
  // 2. NESSUNA etichetta NC in card: il campo dedicato non c'è, il dato
  //    vive nel foglio.
  expect(row.querySelector('.nc-nc-label')).toBeNull();
  // 3. Il dato ASSENTE non diventa mai «senza supervisione» ricostruita.
  expect(within(row).queryByText(t('nc-control-none'))).toBeNull();
}

afterEach(() => setLang('en'));

describe('NC control row: in card resta solo «scaduto» (P3-2)', () => {
  describe('Sidebar desktop — posizione locale', () => {
    for (const lang of LINGUE) {
      it(`server vecchio: riga di presenza, nessuna etichetta NC (${lang})`, () => {
        setLang(lang);
        render(
          <Sidebar
            localNodeId={'c'.repeat(32)} cells={[vivaSenzaCampo()]} sessions={[sessioneIncerta()]}
            onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
          />,
        );
        proveRigaViva(rigaDi('Dev Cell', '[data-roster-key]'));
      });
    }

    it('controllo SCADUTO: l\'etichetta resta in card, perché chiede un intervento', () => {
      setLang('en');
      render(
        <Sidebar
          localNodeId={'c'.repeat(32)}
          cells={[vivaSenzaCampo({ ncControl: 'expired' })]} sessions={[sessioneIncerta()]}
          onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
        />,
      );
      const row = rigaDi('Dev Cell', '[data-roster-key]');
      const nc = row.querySelector('.nc-nc-label');
      expect(nc, 'elemento dedicato .nc-nc-label').toBeTruthy();
      expect(nc.textContent).toBe(t('nc-control-expired'));
    });

    it('controllo ATTESTATO: nessuna etichetta in card, il foglio lo nomina per esteso', () => {
      setLang('en');
      render(
        <Sidebar
          localNodeId={'c'.repeat(32)}
          cells={[vivaSenzaCampo({ ncControl: 'attested' })]} sessions={[sessioneIncerta()]}
          onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
        />,
      );
      const row = rigaDi('Dev Cell', '[data-roster-key]');
      expect(within(row).queryByText(t('nc-control-attested'))).toBeNull();
      expect(row.querySelector('.nc-nc-label')).toBeNull();
    });
  });

  describe('Sidebar desktop — riga remota route-qualified', () => {
    function renderRemota(cells, sessions, fleetState) {
      return render(
        <Sidebar
          localNodeId={'c'.repeat(32)} cells={[]} sessions={[]}
          nodeGroups={[{
            name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
            fleetState, sessions, cells, unmanaged: [], capabilities: [], engines: [],
          }]}
          onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
        />,
      );
    }

    it('la riga remota senza turno qualificato dice la presenza, non l\'anteprima né l\'etichetta', () => {
      setLang('en');
      renderRemota(
        [vivaSenzaCampo({ key: 'relay:cloud-DevCell' })],
        [{ name: 'cloud-DevCell', activity: 2, windows: 1, preview: 'anteprima REMOTA' }],
      );
      const row = rigaDi('Dev Cell', '[data-roster-key]');
      expect(within(row).getByText(t('cell-present'))).toBeTruthy();
      // L'anteprima non è uno stato: non si presenta come tale nella riga.
      expect(within(row).queryByText('anteprima REMOTA')).toBeNull();
      expect(row.querySelector('.nc-nc-label')).toBeNull();
    });

    it('dato fleet conservato (stale): nessuna etichetta prestata, nemmeno scaduta', () => {
      setLang('en');
      renderRemota(
        [vivaSenzaCampo({ key: 'relay:cloud-DevCell', ncControl: 'expired' })],
        [sessioneIncerta()],
        'stale',
      );
      const row = rigaDi('Dev Cell', '[data-roster-key]');
      expect(within(row).queryByText(t('nc-control-expired'))).toBeNull();
      expect(row.querySelector('.nc-nc-label')).toBeNull();
    });

    it('cella preserved: nessuna attestazione corrente, nemmeno nel campo dedicato', () => {
      setLang('en');
      renderRemota(
        [vivaSenzaCampo({ key: 'relay:cloud-DevCell', ncControl: 'expired', preserved: true })],
        [],
        'stale',
      );
      const row = rigaDi('Dev Cell', '[data-roster-key]');
      expect(row.querySelector('.nc-nc-label')).toBeNull();
    });
  });

  describe('SessionList mobile — posizione locale', () => {
    for (const lang of LINGUE) {
      it(`server vecchio: riga di presenza, nessuna etichetta NC (${lang})`, async () => {
        setLang(lang);
        fixture.cells = [vivaSenzaCampo()];
        fixture.sessions = [sessioneIncerta()];
        fixture.nodes = [];
        render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} />);
        await screen.findByText('Dev Cell');
        proveRigaViva(rigaDi('Dev Cell', '.nc-mcard'));
      });
    }

    it('controllo SCADUTO: il badge resta in card anche sul mobile', async () => {
      setLang('en');
      fixture.cells = [vivaSenzaCampo({ ncControl: 'expired' })];
      fixture.sessions = [sessioneIncerta()];
      fixture.nodes = [];
      render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} />);
      await screen.findByText('Dev Cell');
      const row = rigaDi('Dev Cell', '.nc-mcard');
      const nc = row.querySelector('.nc-nc-label');
      expect(nc).toBeTruthy();
      expect(nc.textContent).toBe(t('nc-control-expired'));
    });
  });

  describe('SessionList mobile — riga remota route-qualified', () => {
    it('riga remota di presenza, senza anteprima né etichetta', async () => {
      setLang('en');
      fixture.cells = [];
      fixture.sessions = [];
      fixture.nodes = [{
        name: 'relay', label: 'Relay', route: ['relay'], status: 'up', instanceId: 'd'.repeat(32),
        capabilities: [], engines: [],
        cells: [vivaSenzaCampo({ key: 'relay:cloud-DevCell' })],
        sessions: [{ name: 'cloud-DevCell', activity: 2, windows: 1, preview: 'anteprima REMOTA' }],
        unmanaged: [],
      }];
      render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} />);
      await screen.findByText('Dev Cell');
      const row = rigaDi('Dev Cell', '.nc-mcard');
      expect(within(row).getByText(t('cell-present'))).toBeTruthy();
      expect(within(row).queryByText('anteprima REMOTA')).toBeNull();
      expect(row.querySelector('.nc-nc-label')).toBeNull();
    });
  });

  it('cella spenta: «off», nessuna etichetta NC appesa alla riga', () => {
    setLang('it');
    render(
      <Sidebar
        localNodeId={'c'.repeat(32)}
        cells={[vivaSenzaCampo({ tmux: false, active: false, model: 'glm-5.3' })]} sessions={[]}
        onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
      />,
    );
    const row = rigaDi('Dev Cell', '[data-roster-key]');
    expect(within(row).getByText(t('cell-off'))).toBeTruthy();
    expect(row.querySelector('.nc-nc-label')).toBeNull();
  });
});
