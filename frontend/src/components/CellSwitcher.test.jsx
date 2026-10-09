import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
// Il drawer consuma i gruppi della lista principale (hook useNodes): nei test
// i gruppi sono quelli dello snapshot che ogni caso scrive, cosi' i casi che
// aggiornano lo snapshot a meta' test continuano a vedere il mondo cambiare.
vi.mock('../hooks/useNodes.js', async () => {
  const cache = await import('../lib/cell-switcher-cache.js');
  return { useNodesState: () => ({ groups: (cache.readCellSwitcherSnapshot() || {}).nodeGroups || [], hasLoaded: true }) };
});
// Il locale del drawer vive nel treno condiviso: nei test il treno risponde
// con i mock di api (sessions + fleet locale), cosi' i casi che cambiano i
// mock cambiano il mondo del drawer senza timer da 4 secondi.
vi.mock('../lib/fleet-poll.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    subscribeFleetRoute: (_token, route, onSnapshot) => {
      if (route.length) return () => {};
      const emit = async () => {
        try {
          const res = await mocks.apiFetch('/api/sessions', 'token');
          const sessions = await res.json();
          const fs = await mocks.fleetStatus('token', []);
          onSnapshot({ sessionsJson: JSON.stringify(sessions), sessionsError: null, fs, fleetError: null });
        } catch (_) {
          onSnapshot({ sessionsJson: null, sessionsError: 'mock', fs: null, fleetError: null });
        }
      };
      emit();
      const id = setInterval(emit, 100);
      return () => clearInterval(id);
    },
  };
});
// Le sorgenti pesanti del popup fanno rete (ws, ticket del pannello): stub
// con traccia delle props, stesso pattern di GridTile.test.jsx.
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
import { positionKey } from '../lib/nodes-model.js';
import { t } from '../lib/i18n.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });
const off = (cell, tmuxSession) => ({ cell, tmuxSession, active: false, tmux: false, engine: 'agy.native' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-cell-One', activity: 10, working: true }],
    cells: [active('cell-One', 'cloud-cell-One'), off('cell-Three', 'cloud-cell-Three')],
    nodeGroups: [
      {
        route: ['hub'], label: 'Hub', sessions: [{ name: 'cloud-Remote', activity: 5 }],
        cells: [active('Remote', 'cloud-Remote')],
      },
      {
        route: ['stale'], label: 'Stale', sessions: [{ name: 'cloud-Stale', activity: 8 }],
        cells: [active('Stale Cell', 'cloud-Stale')],
      },
      {
        route: ['alerts'], label: 'Alerts', sessions: [],
        cells: [{ cell: 'Degraded', tmuxSession: 'cloud-Degraded', active: true, tmux: false, degraded: true, engine: 'shell.local' }],
      },
    ],
  });
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [{ name: 'cloud-cell-One', activity: 10, working: true }] }) });
  mocks.getRouteSessions.mockImplementation(async (_token, route) => {
    if (route.join('/') === 'hub') return { sessions: [{ name: 'cloud-Remote', activity: 5 }] };
    return { sessions: [] };
  });
  mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
    if (!route.length) return { available: true, cells: [active('cell-One', 'cloud-cell-One'), off('cell-Three', 'cloud-cell-Three')] };
    if (route.join('/') === 'hub') return { available: true, cells: [active('Remote', 'cloud-Remote')] };
    if (route.join('/') === 'stale') return { available: true, cells: [off('Stale Cell', 'cloud-Stale')] };
    return {
      available: true,
      cells: [{ cell: 'Degraded', tmuxSession: 'cloud-Degraded', active: true, tmux: false, degraded: true, engine: 'shell.local' }],
    };
  });
});

// L'anteprima di una cella si apre col PRIMO tocco della riga. L'anteprima è
// NUDA: una sorgente sola, il flusso — niente tab né comando Live.
const toccaRiga = async (cellName) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${cellName} `) }));
  await screen.findByTestId('cell-switcher-anteprima');
};

// Il selettore rilegge le posizioni a intervalli (in produzione 4 s). Nei test
// l'intervallo e' corto: nessun assert dipende da un timer lungo, che sotto
// carico puo' sforare il budget del waitFor. Era questa la sorgente del flake.
const Switcher = (props) => <CellSwitcher pollMs={20} {...props} />;

describe('CellSwitcher', () => {
  it('uses fresh local and route-qualified fleet data, keeps degraded visible and opens after the fresh re-check', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={onPick} onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: 'Cells / cloud sessions' });
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    // Rows land in a commit later than the dialog: the beforeEach snapshot is
    // not "fresh", so local/remote rows only appear after the first refresh
    // cycle. Wait for the row itself, like every other test in this file —
    // never a sync query right after the dialog alone.
    expect((await screen.findByRole('button', { name: /^cell-One / })).getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('you are here')).toBeTruthy();
    const remote = await screen.findByRole('button', { name: /^Remote / });
    expect(remote).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Degraded / }).getAttribute('aria-disabled')).toBe('true');
    // La pillola di default è «Attive»: la cella spenta NON compare, anche se
    // il filtro del nodo senza preferenze vale 'all' e la lascerebbe passare.
    // «Tutte» la ripristina come riga disabilitata (vedi i test dedicati).
    expect(screen.queryByRole('button', { name: /^cell-Three / })).toBeNull();
    // Stale Cell e' una cella VIVA del suo gruppo (tmux nota): come la
    // principale, e' apribile — l'etichetta del nodo dice altro, la riga no.
    expect(screen.getByRole('button', { name: /^Stale Cell / }).getAttribute('aria-disabled')).toBe('false');
    expect(screen.getByRole('button', { name: 'close cell switcher' })).toBeTruthy();
    // Il drawer non ha più un proprio canale: NESSUNA lettura per-route parte
    // da qui (i gruppi arrivano dalla lista principale, hook useNodes).
    expect(mocks.fleetStatus).not.toHaveBeenCalledWith('token', ['hub']);
    expect(mocks.getRouteSessions).not.toHaveBeenCalledWith('token', ['alerts']);

    // Il PRIMO tocco seleziona (anteprima in alto, riga blu col badge del
    // gesto); il SECONDO sulla stessa riga apre, e il ricontrollo fresco lo
    // precede: nessun attach stantio.
    fireEvent.click(remote);
    expect(remote.getAttribute('data-selected')).toBe('true');
    fireEvent.click(remote);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-Remote', node: 'hub', cellName: 'Remote' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes the full inventory deliberately and refuses an off target with an explicit status', async () => {
    const onPick = vi.fn();
    render(<Switcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const research = screen.getByRole('button', { name: /^cell-Three / });
    expect(research.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(research);
    expect(await screen.findByText('this cell is no longer active')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps deactivated cells out of active mode even when marked degraded', async () => {
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-cell-One', activity: 10, working: true }],
      cells: [active('cell-One', 'cloud-cell-One')],
      nodeGroups: [
        {
          route: ['hub'], label: 'Hub', sessions: [],
          cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
        },
      ],
    });
    mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
      if (!route.length) return { available: true, cells: [active('cell-One', 'cloud-cell-One')] };
      return {
        available: true,
        cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
      };
    });
    mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
    // La modalità attiva del NODO tiene fuori la cella spenta: il drawer
    // segue la stessa vista della lista principale, non un filtro proprio.
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ hub: { filter: 'active' } }));
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    expect(screen.queryByRole('button', { name: /^Ghost Off / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^Ghost Off / }).getAttribute('aria-disabled')).toBe('true');
  });

  // La pillola «Attive» è un gate DI RIGA, non un filtro del nodo: qualunque
  // preferenza abbia salvato il nodo (nulla, 'all', 'pinned'), la cella spenta
  // non compare; «Tutte» la ripristina come riga disabilitata. Il caso
  // 'active' lo copre il test degradato qui sopra.
  it('pillola «Attive», nodo SENZA preferenza: la spenta non compare, «Tutte» la ripristina disabilitata', async () => {
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    // Nessuna preferenza salvata: il filtro del nodo vale 'all', ma la pillola
    // toglie la riga spenta lo stesso.
    expect(screen.queryByRole('button', { name: /^cell-Three / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^cell-Three / }).getAttribute('aria-disabled')).toBe('true');
  });

  it('pillola «Attive», nodo su «all»: la spenta non compare, «Tutte» la ripristina disabilitata', async () => {
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ local: { filter: 'all' } }));
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    // Il nodo mostra tutto per scelta: la pillola resta comunque un gate di riga.
    expect(screen.queryByRole('button', { name: /^cell-Three / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^cell-Three / }).getAttribute('aria-disabled')).toBe('true');
  });

  it('pillola «Attive», nodo su «pinned» con la spenta pinnata: la spenta non compare, «Tutte» la ripristina disabilitata', async () => {
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ local: { filter: 'pinned' } }));
    localStorage.setItem('nc_pins', JSON.stringify([positionKey([], 'cloud-cell-Three')]));
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    // Con il filtro 'pinned' del nodo resterebbe SOLO la spenta pinnata: la
    // pillola la toglie, e del gruppo locale non si vede nessuna riga. Il
    // gruppo hub (nessuna preferenza) tiene la sua cella viva.
    await screen.findByRole('button', { name: /^Remote / });
    expect(screen.queryByRole('button', { name: /^cell-Three / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^cell-One / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^cell-Three / }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: /^cell-One / })).toBeTruthy();
  });

  it('renders each distinct local cell exactly once (no client-side doubling)', async () => {
    const localCells = [
      active('cell-One', 'cloud-cell-One'), active('Alpha', 'cloud-Alpha'),
      off('Fork', 'cloud-Fork'), off('Gamma', 'cloud-Gamma'),
      active('cell-Two', 'cloud-cell-Two'), active('cell-Three', 'cloud-cell-Three'),
      off('cell-Five', 'cloud-cell-Five'), off('cell-Six', 'cloud-cell-Six'),
      off('cell-Seven', 'cloud-cell-Seven'), active('cell-Four', 'cloud-cell-Four'),
      off('cell-Eight', 'cloud-cell-Eight'), off('cell-Nine', 'cloud-cell-Nine'),
      active('Beta', 'cloud-Beta'), active('Shell', 'cloud-Shell'),
    ];
    writeCellSwitcherSnapshot({
      sessions: localCells.filter((c) => c.active).map((c) => ({ name: c.tmuxSession, activity: 1 })),
      cells: localCells,
      nodeGroups: [],
    });
    mocks.fleetStatus.mockResolvedValue({ available: true, cells: localCells });
    mocks.apiFetch.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        sessions: localCells.filter((c) => c.active).map((c) => ({ name: c.tmuxSession, activity: 1 })),
      }),
    });
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    for (const cell of localCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
  });

  // Forma REALE misurata il 2026-08-06 su un client federato (client-federato): il nodo
  // VL vive su owner-host, quindi `vlNodeToPeer` gli assegna la route dell'OWNER —
  // la stessa route del gruppo Fleet di owner-host. Due gruppi, una sola posizione.
  // Il test precedente ('no client-side doubling') usa nodeGroups: [] e non
  // puo' vedere questo caso: il difetto vive esattamente nei gruppi.
  it('never doubles a fleet position when a VL node shares its route', async () => {
    const route = ['cloud-example-com'];
    const vpsCells = [
      active('cell-One', 'cloud-cell-One'), active('cell-Two', 'cloud-cell-Two'),
      active('cell-Three', 'cloud-cell-Three'), active('cell-Four', 'cloud-cell-Four'),
    ];
    const vpsSessions = vpsCells.map((c) => ({ name: c.tmuxSession, activity: 1 }));
    writeCellSwitcherSnapshot({
      // Il client-federato non ha celle proprie attive: tutto cio' che si vede arriva
      // dalla posizione remota.
      sessions: [],
      cells: [],
      nodeGroups: [
        { route, label: 'Group-Cloud', sessions: vpsSessions, cells: vpsCells },
        // Come lo produce vlSidebarGroups: cells vuote, e concatenato DOPO i
        // gruppi Fleet (useNodes.js) — per questo, a chiave uguale, vince lui.
        { kind: 'vl', name: 'vl-0123abcd', route, label: 'VL-Node-A', sessions: [], cells: [] },
      ],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
    mocks.getRouteSessions.mockResolvedValue({ sessions: vpsSessions });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: vpsCells }
      : { available: true, cells: [] }));

    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    for (const cell of vpsCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
    // Un nodo VL non e' una posizione Fleet: non deve prestare la sua etichetta
    // alle celle di owner-host. Se questa riga passa mentre quella sopra fallisce, la
    // duplicazione e' solo mascherata.
    expect(screen.queryByText(/VL-Node-A/)).toBeNull();
  });

  it('shows cell telemetry with its direction baked into the text: context is free, tiers are used', async () => {
    const telemetry = { ts: Date.now(), contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8 };
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-cell-One', activity: 10, working: true, telemetry }],
      cells: [active('cell-One', 'cloud-cell-One')],
      nodeGroups: [],
    });
    // Anche il poll deve riportarla, o la riga la mostra e la perde al primo refresh.
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: 10, working: true, telemetry }],
    }) });
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    // Il verso è scritto DENTRO ogni etichetta: «free» sul contesto E «used»
    // su ogni tier. Un tier senza il suo verso prenderebbe per contagio il
    // «free» del vicino e la riga direbbe il contrario del vero.
    expect(await screen.findByText('context 71% free · 5h used 33% · 7d used 8%')).toBeTruthy();
  });

  it('no telemetry, no field: cells that do not publish it keep the row exactly as it was', async () => {
    // Nessuna sessione porta telemetria (celle non-Claude: assenza legittima).
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await screen.findByRole('button', { name: /^cell-Three / });
    expect(document.querySelectorAll('.nc-cell-switcher-telemetry').length).toBe(0);
    // E nemmeno un segnaposto al posto del campo: nessuna percentuale, mai.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('l\'anteprima del selettore è NUDA: flusso vivo, nessuna tab, nessun comando Live', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [
      { ...active('cell-One', 'cloud-cell-One'), panelUrl: 'https://panel.example' },
    ] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: 0, preview: 'frame-uno' }],
    }) });
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await toccaRiga('cell-One');
    // Il corpo dell'anteprima è il flusso della sessione: il terminale c'è, e
    // dell'attorno (tab delle sorgenti, comando Live host) non c'è niente.
    // Le sorgenti restano nel popup libero e nella nuvola; le azioni vivono
    // nel foglio della riga.
    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('cloud-cell-One');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(document.querySelector('.nc-peek-sorgenti')).toBeNull();
    expect(document.querySelector('.nc-peek-host')).toBeNull();
  });

  it('a cell that disappears from the updated list closes the preview instead of showing its dead frame', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: 0 }],
    }) });
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await toccaRiga('cell-One');
    await screen.findByTestId('peek-term');
    // La cella muore sotto l'anteprima: la chiave non risolve più niente e
    // l'anteprima si chiude da sé. L'alternativa — il contenuto di un'altra
    // cella creduta la propria — è il difetto che questo test tiene chiuso.
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [] }));
    // La cella sparisce MA la sessione tmux resta: la riga diventa unmanaged
    // con la STESSA chiave e l'anteprima resta valida (il flusso e' vivo).
    // Solo quando sparisce anche la SESSIONE la chiave non risolve piu'
    // niente e l'anteprima si chiude da se'.
    await waitFor(() => expect(screen.queryByTestId('cell-switcher-anteprima')).not.toBeNull(), { timeout: 4000 });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
    await waitFor(() => expect(screen.queryByTestId('cell-switcher-anteprima')).toBeNull(), { timeout: 4000 });
  });

  it('il primo tocco apre il FLUSSO in anteprima e non apre la cella: guardare non e\' andare', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-cell-One', activity: 0 }],
    }) });
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={onPick} onClose={onClose} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(riga);
    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('cloud-cell-One');
    // La riga e' SELEZIONATA, col badge che dice il gesto.
    expect(riga.getAttribute('data-selected')).toBe('true');
    expect(riga.textContent).toContain('2 taps = open');
    // Guardare non è andare: nessuna cella aperta, il selettore resta aperto.
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // I quattro test del pannello (raggiungibilità dall'elenco + origin P0)
  // sono stati ricollocati: con l'anteprima nuda il pannello non è
  // più raggiungibile dal selettore. Le guardie P0 sulla porta stanno in
  // src/lib/panel-port.test.js; il contratto CellPeekBody→CellPanel in
  // CellPeekBody.test.jsx.

  it('the row renders what the cell is doing: fresh activity as its age, stale or absent as nothing', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [
      active('cell-One', 'cloud-cell-One'), active('cell-Three', 'cloud-cell-Three'),
    ] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [
        { name: 'cloud-cell-One', activity: Date.now() - 2 * 60 * 1000 },
        { name: 'cloud-cell-Three', activity: Date.now() - 2 * 60 * 60 * 1000 },
      ],
    }) });
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    // Fresca: l'età c'è, con la sua etichetta. Stantia (2h): oltre soglia il
    // campo sparisce — un valore morto che sembra fresco è peggio di nessuno.
    await waitFor(() => expect(screen.getByText(/activity \d+m/)).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText(/activity \d+h/)).toBeNull();
    expect(document.querySelectorAll('.nc-cell-switcher-telemetry').length).toBe(1);
  });

  it('attività, telemetria e stato di una riga REMOTA vengono dalle sessioni di QUELLA route, mai dall\'omonima locale', async () => {
    // Una sessione LOCALE che si chiama come quella remota, con numeri diversi e
    // piu' vecchi: se la riga leggesse la tabella locale mostrerebbe l'altra
    // cella — stato «in attesa» e nessuna attività, perche' stantia.
    const vecchia = Date.now() - 3 * 60 * 60 * 1000;
    const fresca = Date.now() - 90 * 1000;
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Remote', activity: vecchia, working: false }],
    }) });
    mocks.getRouteSessions.mockResolvedValue({
      sessions: [{ name: 'cloud-Remote', activity: fresca, working: true }],
    });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: [active('Remote', 'cloud-Remote')] }
      : { available: true, cells: [] }));
    writeCellSwitcherSnapshot({
      sessions: [], cells: [],
      nodeGroups: [{
        route: ['hub'], label: 'Hub', switcherFresh: true,
        sessions: [{ name: 'cloud-Remote', activity: fresca, working: true }],
        cells: [active('Remote', 'cloud-Remote')],
      }],
    });
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    const riga = await screen.findByRole('button', { name: /^Remote / });
    await waitFor(() => expect(riga.querySelector('.nc-cell-switcher-telemetry')?.textContent)
      .toMatch(/activity \d+m/));
    expect(riga.querySelector('.nc-cell-switcher-state').textContent).toBe(t('cell-working'));
    // L'omonima locale non ha lasciato traccia: e' la riga remota a parlare.
    expect(riga.querySelector('.nc-cell-switcher-telemetry').textContent).not.toMatch(/\dh/);
  });

  it('l\'intestazione sta in alto, e il riordino e\' una modalita\'', async () => {
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    // Titolo, riordino, filtro e chiudi PRIMA della lista: erano in fondo.
    const aside = document.querySelector('.nc-cell-switcher');
    expect(aside.firstElementChild.className).toContain('nc-cell-switcher-controls');
    expect(screen.getByRole('button', { name: 'all' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'close cell switcher' })).toBeTruthy();

    // Spenta, le maniglie non esistono nel DOM; accesa, compaiono.
    const riordino = screen.getByRole('button', { name: 'reorder' });
    expect(riordino.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: 'reorder cell-One' })).toBeNull();
    fireEvent.click(riordino);
    expect(riordino.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'reorder cell-One' })).toBeTruthy();
  });

  it('con il foglio aperto l\'Escape chiude il FOGLIO, non il selettore', async () => {
    // Il guscio del foglio ascolta il keydown sullo STESSO documento: senza la
    // guardia, un Escape chiuderebbe tutte e due le cose e l'operatore
    // perderebbe il selettore mentre stava scegliendo.
    const onClose = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={onClose} />);
    await screen.findByRole('button', { name: 'Cell actions: cell-One' });
    fireEvent.click(screen.getByRole('button', { name: 'Cell actions: cell-One' }));
    expect(await screen.findByTestId('cell-actions-sheet')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('cell-actions-sheet')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    // Il selettore e' ancora li': il secondo Escape chiude lui.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape without trapping focus', () => {
    const onClose = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves unmanaged sessions in the shared order and keeps an off cell in place when it returns', async () => {
    const localSessions = [
      { name: 'cloud-cell-One', activity: 10, working: true },
      { name: 'my-build-watch', activity: 5, preview: 'watching build' },
    ];
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({
      local: ['cloud-cell-One', 'my-build-watch', 'cloud-cell-Three'],
    }));
    writeCellSwitcherSnapshot({
      sessions: localSessions,
      cells: [active('cell-One', 'cloud-cell-One'), off('cell-Three', 'cloud-cell-Three')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: localSessions }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('cell-One', 'cloud-cell-One'), off('cell-Three', 'cloud-cell-Three')],
    });
    const first = render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    // Riordino a MODALITA', come nella home mobile: la maniglia esiste solo a
    // modalita' accesa, e il gesto — trascinamento, tastiera, stessa chiave
    // condivisa — non cambia.
    fireEvent.click(screen.getByRole('button', { name: 'reorder' }));
    const researchHandle = screen.getByRole('button', { name: 'reorder cell-Three' });
    const devRow = screen.getByRole('button', { name: /^cell-One / }).closest('[data-roster-key]');
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => devRow) });
    fireEvent.pointerDown(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 20 });
    fireEvent.pointerMove(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    fireEvent.pointerUp(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))?.local)
      .toEqual(['cloud-cell-Three', 'cloud-cell-One', 'my-build-watch']));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
    expect(researchHandle.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');

    first.unmount();
    writeCellSwitcherSnapshot({
      sessions: [
        { name: 'cloud-cell-One', activity: 10, working: true },
        { name: 'cloud-cell-Three', activity: 2, working: false },
      ],
      cells: [active('cell-One', 'cloud-cell-One'), active('cell-Three', 'cloud-cell-Three')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [
        { name: 'cloud-cell-One', activity: 10, working: true },
        { name: 'cloud-cell-Three', activity: 2, working: false },
      ],
    }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('cell-One', 'cloud-cell-One'), active('cell-Three', 'cloud-cell-Three')],
    });
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-Three / });
    expect([...document.querySelectorAll('.nc-cell-switcher-row[data-position="local"]')]
      .map((row) => row.dataset.rosterKey)).toEqual(['cloud-cell-Three', 'cloud-cell-One']);
  });

  // R27 #4: «questa cella non è più attiva» detto quando è la VERIFICA a
  // fallire (rete, timeout, 502) induce a riavviare una cella che stava
  // lavorando. «Non ho potuto verificare» non autorizza «verificato spenta».
  it('aprire con la verifica fallita dice «non ho potuto verificare», non «non è più attiva»', async () => {
    const onPick = vi.fn();
    render(<Switcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    const remote = await screen.findByRole('button', { name: /^Remote / });
    // La verifica del SECONDO tocco parte adesso e fallisce (502): la lettura
    // non è riuscita, la cella NON è stata trovata spenta.
    mocks.fleetStatus.mockImplementation(async () => { throw new Error('HTTP 502'); });
    fireEvent.click(remote); // primo tocco: seleziona
    fireEvent.click(remote); // secondo tocco: la verifica NON riesce
    // La lettura fallita non ha trovato la cella spenta: la riga e' quella
    // della lista principale, che apre con la sola tmux nota. Si APRE, e non
    // dice NE «spenta» (menzogna) NE «non verificata» (blocco inutile).
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-Remote', node: 'hub', cellName: 'Remote' }));
    expect(screen.queryByText('this cell is no longer active')).toBeNull();
    expect(screen.queryByText('Could not verify: try again shortly.')).toBeNull();
  });

  it('aprire una cella VERIFICATA spenta dice ancora «non è più attiva»', async () => {
    const onPick = vi.fn();
    render(<Switcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    const remote = await screen.findByRole('button', { name: /^Remote / });
    // Lettura riuscita (fresh) e la cella risulta davvero spenta: qui
    // «non più attiva» è la verità e deve restare.
    mocks.fleetStatus.mockImplementation(async (_t, r = []) => (r.length
      ? { available: true, cells: [off('Remote', 'cloud-Remote')] }
      : { available: true, cells: [active('cell-One', 'cloud-cell-One')] }));
    mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
    fireEvent.click(remote); // primo tocco: seleziona
    fireEvent.click(remote); // secondo tocco: la verifica dice spenta
    expect(await screen.findByText('this cell is no longer active')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a row whose fleet read fails stays, shows its last known state and opens like the main list', async () => {
    // A failed fleet read preserves the last known list and its state.
    // Selecting that main-list row opens the known tmux session.
    const onPick = vi.fn();
    mocks.fleetStatus.mockImplementation(async () => { throw new Error('HTTP 502'); });
    render(<Switcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    const dev = await screen.findByRole('button', { name: /^cell-One / });
    expect(dev.textContent).toContain('working');
    expect(dev.textContent).not.toContain('status not confirmed');
    fireEvent.click(dev);
    fireEvent.click(dev);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-cell-One', cellName: 'cell-One' }));
    expect(screen.queryByText('this cell is no longer active')).toBeNull();
  });
});

// Il pin (la stella) nel selettore compatto.
//
// Il telefono non aveva una stella: una cella si pinnava dalla home e dalla
// sidebar desktop, non dalla superficie che si usa col pollice. Ora il pin e'
// una VOCE del foglio azioni — la riga resta pallino + testo + ⋯ — e questi
// test ne fissano il contratto: lo stesso ciclo, la stessa chiave di pin che la
// home legge, e un tocco che non apre la cella sotto.
describe('CellSwitcher — il pin nel foglio azioni', () => {
  const hostNone = { local: { hostCell: null, threadStatus: 'absent' } };
  const apriFoglio = async (cellName) => {
    fireEvent.click(await screen.findByRole('button', { name: `Cell actions: ${cellName}` }));
    return screen.findByTestId('cell-actions-sheet');
  };

  it('(a) in fila non c\'e\' piu\': il pin e\' una voce del foglio, su locale e federata', async () => {
    const { container } = render(
      <CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} hostByRoute={hostNone} />,
    );
    await screen.findByRole('button', { name: /^cell-One / });

    // CONTROLLO NEGATIVO: nessuna stella in fila, su nessuna riga.
    expect(screen.queryByRole('button', { name: 'pin to top cell-One' })).toBeNull();
    expect(container.querySelectorAll('[data-cell-star]')).toHaveLength(0);
    const rows = container.querySelectorAll('.nc-cell-switcher-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const nome of ['cell-One', 'Remote']) {
      const foglio = await apriFoglio(nome);
      expect(within(foglio).getByRole('menuitem', { name: 'Pin to top' })).toBeTruthy();
      fireEvent.click(within(foglio).getByRole('button', { name: 'close' }));
    }
  });

  it('(b) il tocco della voce pinna e non apre la cella sotto', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<Switcher token="token" current={{}} onPick={onPick} onClose={onClose} hostByRoute={hostNone} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const foglio = await apriFoglio('cell-One');
    fireEvent.click(within(foglio).getByRole('menuitem', { name: 'Pin to top' }));

    expect(JSON.parse(localStorage.getItem('nc_pins'))).toContain(positionKey([], 'cloud-cell-One'));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cell-actions-sheet')).toBeNull();
  });

  it('(c) pinna la stessa chiave che legge la home, route-qualificata per un nodo remoto', async () => {
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} hostByRoute={hostNone} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const primo = await apriFoglio('cell-One');
    fireEvent.click(within(primo).getByRole('menuitem', { name: 'Pin to top' }));
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toEqual([positionKey([], 'cloud-cell-One')]);

    const secondo = await apriFoglio('Remote');
    fireEvent.click(within(secondo).getByRole('menuitem', { name: 'Pin to top' }));
    const pins = JSON.parse(localStorage.getItem('nc_pins'));
    expect(pins).toContain(positionKey(['hub'], 'cloud-Remote'));
    expect(pins).toContain(positionKey([], 'cloud-cell-One'));

    // Il foglio DICE il pin che ha appena scritto: la voce si chiama «togli».
    const terzo = await apriFoglio('cell-One');
    expect(within(terzo).getByRole('menuitem', { name: 'Unpin from top' })).toBeTruthy();
  });

  it('(d) pinna e basta: non designa mai', async () => {
    const onDesignateCell = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} hostByRoute={hostNone} onDesignateCell={onDesignateCell} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const primo = await apriFoglio('cell-One');
    fireEvent.click(within(primo).getByRole('menuitem', { name: 'Pin to top' }));
    expect(onDesignateCell).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toContain(positionKey([], 'cloud-cell-One'));

    // Secondo tocco: il pin va via, e non e' stato designato niente.
    const secondo = await apriFoglio('cell-One');
    fireEvent.click(within(secondo).getByRole('menuitem', { name: 'Unpin from top' }));
    expect(onDesignateCell).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('nc_pins')) || []).not.toContain(positionKey([], 'cloud-cell-One'));
  });

  it('(e) la voce del pin non parla della designazione: quella e\' la voce Live', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onDesignateCell = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      hostByRoute={{ local: { hostCell: 'cell-One', threadStatus: 'absent', hostRevision: 2 } }} onDesignateCell={onDesignateCell} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const foglio = await apriFoglio('cell-One');
    // La cella E' l'ospite: il foglio lo dice con la voce Live (che offre di
    // toglierla), e il pin resta un pin.
    expect(within(foglio).getByRole('menuitem', { name: 'Remove Live' })).toBeTruthy();
    fireEvent.click(within(foglio).getByRole('menuitem', { name: 'Pin to top' }));
    expect(onDesignateCell).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});

// Il comando Live esplicito: una chiamata sola che legge la revisione e scrive
// con quella, e un esito che la riga di stato mostra. Ora la voce sta nel foglio
// azioni: gli esiti — applicato, rifiutato — devono restare visibili tutti e due.
describe('CellSwitcher — il comando Live esplicito', () => {
  const apriFoglio = async (cellName) => {
    fireEvent.click(await screen.findByRole('button', { name: `Cell actions: ${cellName}` }));
    return screen.findByTestId('cell-actions-sheet');
  };

  it('designa con la revisione che il server ha appena detto, e lo dice', async () => {
    mocks.getLiveHost.mockResolvedValue({ hostCell: null, revision: 4, eligible: true, threadStatus: 'absent' });
    mocks.designateHostCell.mockResolvedValue({ hostCell: 'cell-One', revision: 5 });
    const onLiveHostApplied = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      hostByRoute={{}} onLiveHostApplied={onLiveHostApplied} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const foglio = await apriFoglio('cell-One');
    fireEvent.click(within(foglio).getByRole('menuitem', { name: 'Assign Live' }));

    await waitFor(() => expect(mocks.designateHostCell).toHaveBeenCalledWith('token', 'cell-One', 4, []));
    expect(onLiveHostApplied).toHaveBeenCalledWith({ route: [], hostCell: 'cell-One', revision: 5 });
    expect(await screen.findByText(`Live host: cell-One`)).toBeTruthy();
  });

  it('mostra il rifiuto nella riga di stato e lascia lo stato com\'era', async () => {
    mocks.getLiveHost.mockResolvedValue({ hostCell: null, revision: 4, eligible: true, threadStatus: 'absent' });
    mocks.designateHostCell.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403, data: { reason: 'live-host-not-granted' } }));
    const onLiveHostApplied = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      hostByRoute={{}} onLiveHostApplied={onLiveHostApplied} />);
    await screen.findByRole('button', { name: /^cell-One / });

    const foglio = await apriFoglio('cell-One');
    fireEvent.click(within(foglio).getByRole('menuitem', { name: 'Assign Live' }));

    expect(await screen.findByText(t('live-host-not-granted'))).toBeTruthy();
    expect(onLiveHostApplied).not.toHaveBeenCalled();
  });
});

// Il tasto della doppia vista: affianca la riga, o la toglie se è già
// affiancata. Tre stati (disabilitato sulla cella aperta, vuoto sulle righe
// selezionabili, disabilitato sulle non raggiungibili), nessun effetto sulla
// riga al di là del toggle, e NIENTE tasto senza `onToggleSide` — desktop e
// liste senza doppia vista restano identiche.
describe('CellSwitcher side key', () => {
  const REMOTE_KEY = positionKey(['hub'], 'cloud-Remote');

  const riga = async (cellName) => {
    const selezione = await screen.findByRole('button', { name: new RegExp(`^${cellName} `) });
    return selezione.closest('div[data-roster-key]');
  };
  const tastoAffianca = (rigaElemento) =>
    within(rigaElemento).queryByRole('button', { name: t('cell-switcher-side-add') });
  const tastoTogli = (rigaElemento) =>
    within(rigaElemento).queryByRole('button', { name: t('cell-switcher-side-remove') });

  it('senza onToggleSide non rende nessun tasto: il DOM resta quello di oggi', async () => {
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await riga('cell-One');
    expect(screen.queryByRole('button', { name: t('cell-switcher-side-add') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('cell-switcher-side-remove') })).toBeNull();
  });

  it('tre stati: disabilitato sulla cella aperta, vuoto sulle selezionabili, disabilitato sulle non raggiungibili', async () => {
    const onToggleSide = vi.fn();
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={vi.fn()} onClose={vi.fn()} onToggleSide={onToggleSide} />);

    // (a) la riga aperta: disabilitato, mai premuto
    const qui = tastoAffianca(await riga('cell-One'));
    expect(qui).toBeTruthy();
    expect(qui.disabled).toBe(true);
    expect(qui.getAttribute('aria-pressed')).toBe('false');

    // (c) una riga selezionabile: attivo, vuoto (non premuto), etichette
    const altra = tastoAffianca(await riga('Remote'));
    expect(altra).toBeTruthy();
    expect(altra.disabled).toBe(false);
    expect(altra.getAttribute('aria-pressed')).toBe('false');
    expect(altra.getAttribute('title')).toBe(t('cell-switcher-side-add'));
    expect(altra.getAttribute('aria-label')).toBe(t('cell-switcher-side-add'));
    // L'icona è a tratto (fill none, currentColor): un SVG senza attributi
    // qui riempiva il rettangolo di nero — il quadrato pieno di B4.
    const icona = altra.querySelector('svg');
    expect(icona).toBeTruthy();
    expect(icona.getAttribute('fill')).toBe('none');
    expect(icona.getAttribute('stroke')).toBe('currentColor');

    // la cella degradata si vede (attiva ma degradata) e non è raggiungibile:
    // il suo tasto è disabilitato
    const degradata = tastoAffianca(await riga('Degraded'));
    expect(degradata).toBeTruthy();
    expect(degradata.disabled).toBe(true);
  });

  it('il tocco affianca: onToggleSide una volta con la riga, senza aprire né selezionare', async () => {
    const onToggleSide = vi.fn(); const onPick = vi.fn(); const onClose = vi.fn();
    render(<Switcher token="token" current={{ session: 'cloud-cell-One' }} onPick={onPick} onClose={onClose} onToggleSide={onToggleSide} />);
    const rigaRemote = await riga('Remote');

    fireEvent.click(within(rigaRemote).getByRole('button', { name: t('cell-switcher-side-add') }));

    expect(onToggleSide).toHaveBeenCalledTimes(1);
    expect(onToggleSide.mock.calls[0][0].key).toBe(REMOTE_KEY);
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cell-switcher-anteprima')).toBeNull();
    expect(within(rigaRemote).getByRole('button', { name: /^Remote / }).getAttribute('data-selected')).toBeNull();
  });

  it('riga affiancata: tasto premuto col titolo per togliere, riga spenta, il tocco chiama il toggle', async () => {
    const onToggleSide = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      sideKey={REMOTE_KEY} onToggleSide={onToggleSide} />);
    const rigaRemote = await riga('Remote');

    // (b) premuto, e la frase per togliere
    expect(tastoAffianca(rigaRemote)).toBeNull();
    const premuto = tastoTogli(rigaRemote);
    expect(premuto).toBeTruthy();
    expect(premuto.getAttribute('aria-pressed')).toBe('true');
    expect(premuto.disabled).toBe(false);
    // la riga "si spegne" come le .off, ma resta una riga selezionabile
    expect(rigaRemote.className).toContain(' side');
    expect(rigaRemote.className).not.toContain(' off');

    fireEvent.click(premuto);
    expect(onToggleSide).toHaveBeenCalledTimes(1);
    expect(onToggleSide.mock.calls[0][0].key).toBe(REMOTE_KEY);
    expect(screen.queryByTestId('cell-switcher-anteprima')).toBeNull();
  });

  it('una riga non selezionabile non si affianca: disabilitato anche in modalità tutte', async () => {
    const onToggleSide = vi.fn();
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} onToggleSide={onToggleSide} />);
    await riga('cell-One');
    fireEvent.click(screen.getByRole('button', { name: 'all' }));

    const spenta = await riga('cell-Three');
    const tasto = tastoAffianca(spenta);
    expect(tasto).toBeTruthy();
    expect(tasto.disabled).toBe(true);

    fireEvent.click(tasto);
    expect(onToggleSide).not.toHaveBeenCalled();
  });
});

describe('quick cell list follows the normal list ordering', () => {
  const northId = 'a'.repeat(32);
  const southId = 'b'.repeat(32);
  const keyOf = (route, tmux) => positionKey([route], tmux);
  const positionLabels = () => [...document.querySelectorAll('.nc-cell-switcher-position')].map((e) => e.textContent);
  const groupRole = (text) => (text.includes('Node-Local') ? 'local' : text.includes('South') ? 'south' : 'north');
  const rowKeys = () => [...document.querySelectorAll('[data-roster-key]')].map((e) => e.dataset.rosterKey);
  const mgmFeed = [
    { ...active('Cell-1', 'north-c1'), activity: 40 },
    { ...active('Cell-2', 'north-c2'), activity: 30 },
    { ...active('Cell-3', 'north-c3'), activity: 20 },
    { ...active('Cell-4', 'north-c4'), activity: 10 },
  ];
  const vpsFeed = [
    { ...active('Cell-A', 'south-c1'), activity: 40 },
    { ...active('Cell-B', 'south-c2'), activity: 30 },
    { ...active('Cell-C', 'south-c3'), activity: 20 },
    { ...active('Cell-D', 'south-c4'), activity: 10 },
  ];
  // Ordine di arrivo dal feed: il nodo hub prima del nodo edge.
  const writeFixtureSnapshot = () => writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-cell-One', activity: 10, working: true }],
    cells: [active('cell-One', 'cloud-cell-One')],
    localFresh: true,
    nodeGroups: [
      { route: ['north'], label: 'North', instanceId: northId, sessions: [], cells: mgmFeed },
      { route: ['south'], label: 'South', instanceId: southId, sessions: [], cells: vpsFeed },
    ],
  });

  it('node groups follow the user node order and pinned cells keep the manual order', async () => {
    writeFixtureSnapshot();
    localStorage.setItem('nc_node_order_v1', JSON.stringify([`id:${southId}`, `id:${northId}`]));
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ south: { filter: 'pinned' } }));
    const southOrder = [keyOf('south', 'south-c3'), keyOf('south', 'south-c4'), keyOf('south', 'south-c1'), keyOf('south', 'south-c2')];
    localStorage.setItem('nc_pins', JSON.stringify(southOrder));
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ south: southOrder }));
    mocks.getRouteSessions.mockImplementation(async (_token, route) => {
      if (route.join('/') === 'north') return { sessions: [
        { name: 'north-c1', activity: 40 }, { name: 'north-c2', activity: 30 },
        { name: 'north-c3', activity: 20 }, { name: 'north-c4', activity: 10 },
      ] };
      if (route.join('/') === 'south') return { sessions: [
        { name: 'south-c1', activity: 40 }, { name: 'south-c2', activity: 30 },
        { name: 'south-c3', activity: 20 }, { name: 'south-c4', activity: 10 },
      ] };
      return { sessions: [] };
    });
    mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
      if (route.join('/') === 'north') return { available: true, cells: mgmFeed };
      if (route.join('/') === 'south') return { available: true, cells: vpsFeed };
      if (!route.length) return { available: true, cells: [active('cell-One', 'cloud-cell-One')] };
      return { available: true, cells: [] };
    });

    render(<Switcher token="token" current={{}} localNodeLabel="Node-Local" onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    // Le righe remote arrivano col primo ciclo di refresh verificato.
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => expect(rowKeys().length).toBe(9), { timeout: 4000 });
    // Node groups: the locale first, then the user order from the normal list
    // (the edge node before the hub node), never the arrival order of the feed.
    expect(groupRole(positionLabels()[0])).toBe('local');
    expect(positionLabels().map(groupRole)).toEqual(['local', 'south', 'north']);
    // The edge node is in "pinned" mode in the normal list: the manual pinned order
    // (Personal, Research, Trading, Dev) governs the quick list too.
    const southRows = rowKeys().filter((k) => k.startsWith('south:'));
    expect(southRows).toEqual(southOrder);
    // The other node has no pins or manual order: the activity fallback keeps the rows
    // in the received order, exactly like the live cells of the normal list.
    expect(rowKeys().filter((k) => k.startsWith('north:'))).toEqual([
      keyOf('north', 'north-c1'), keyOf('north', 'north-c2'), keyOf('north', 'north-c3'), keyOf('north', 'north-c4'),
    ]);

    // The user reorders the nodes: the quick list follows immediately.
    localStorage.setItem('nc_node_order_v1', JSON.stringify([`id:${northId}`, `id:${southId}`]));
    window.dispatchEvent(new Event('nexuscrew-node-preferences'));
    await waitFor(() => expect(positionLabels().map(groupRole)).toEqual(['local', 'north', 'south']));
  });
});

describe('quick cell list keeps every node visible', () => {
  const northId = 'c'.repeat(32);
  const keyOf = (route, tmux) => positionKey([route], tmux);
  const southId = 'd'.repeat(32);
  const Switcher = (props) => <CellSwitcher pollMs={20} {...props} />;
  const positionLabels = () => [...document.querySelectorAll('.nc-cell-switcher-position')].map((e) => e.textContent);
  const groupRole = (text) => (text.includes('Node-Local') ? 'local' : text.includes('North') ? 'north' : 'south');
  const rowKeys = () => [...document.querySelectorAll('[data-roster-key]')].map((e) => e.dataset.rosterKey);
  const northFeed = [
    { ...active('Hub-Cell-1', 'north-c1'), activity: 40 },
    { ...active('Hub-Cell-2', 'north-c2'), activity: 30 },
  ];
  const southFeed = [
    { ...active('Far-Cell-1', 'south-c1'), activity: 20 },
    { ...active('Far-Cell-2', 'south-c2'), activity: 10 },
  ];
  // Ordine di arrivo dal feed: il nodo a due salti prima dell'hub diretto.
  const writeFixtureSnapshot = () => writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-cell-One', activity: 10, working: true }],
    cells: [active('cell-One', 'cloud-cell-One')],
    localFresh: true,
    nodeGroups: [
      { route: ['south'], label: 'South', instanceId: southId, sessions: [], cells: southFeed },
      { route: ['north'], label: 'North', instanceId: northId, sessions: [], cells: northFeed },
    ],
  });

  it('a direct hub whose reads are not verified stays a visible group, in the user node order', async () => {
    writeFixtureSnapshot();
    localStorage.setItem('nc_node_order_v1', JSON.stringify([`id:${northId}`, `id:${southId}`]));
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ north: { filter: 'all' }, south: { filter: 'all' } }));
    // Hub diretto: le letture NON si verificano in questo giro (fleet non
    // available, sessioni vuote). Il gruppo esiste nelle nodeGroups e deve
    // restare visibile: sparire faceva sembrare il nodo assente.
    mocks.getRouteSessions.mockImplementation(async (_token, route) => {
      if (route.join('/') === 'north') return { sessions: [] };
      if (route.join('/') === 'south') return { sessions: [
        { name: 'south-c1', activity: 40 }, { name: 'south-c2', activity: 30 },
      ] };
      return { sessions: [] };
    });
    mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
      if (route.join('/') === 'north') return { available: false };
      if (route.join('/') === 'south') return { available: true, cells: southFeed };
      if (!route.length) return { available: true, cells: [active('cell-One', 'cloud-cell-One')] };
      return { available: true, cells: [] };
    });

    const onPick = vi.fn();
    render(<Switcher token="token" current={{}} localNodeLabel="Node-Local" onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    await waitFor(() => expect(rowKeys().some((k) => k.startsWith('south:'))).toBe(true));
    // Tre gruppi nell'ordine scelto dall'utente: locale, hub diretto, nodo
    // raggiunto attraverso l'hub.
    expect(positionLabels().map(groupRole)).toEqual(['local', 'north', 'south']);
    // Le celle dell'hub, anche con letture non verificate, sono SELEZIONABILI
    // come nella lista normale (tmux noto al gruppo): doppio tocco e apre la
    // route giusta con la sessione esatta.
    const hubRow = await screen.findByRole('button', { name: /^Hub-Cell-1 / });
    expect(hubRow.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(hubRow);
    fireEvent.click(hubRow);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({
      session: 'north-c1', node: 'north', cellName: 'Hub-Cell-1',
    }));
    // Col filtro "all" le celle dell'hub restano elencate nell'ordine ricevuto.
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(rowKeys().filter((k) => k.startsWith('north:'))).toEqual([
      keyOf('north', 'north-c1'), keyOf('north', 'north-c2'),
    ]);
  });
});
