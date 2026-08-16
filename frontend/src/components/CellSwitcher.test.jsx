import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
}));
// Le sorgenti pesanti del popup fanno rete (ws, ticket del pannello): stub
// con traccia delle props, stesso pattern di GridTile.test.jsx.
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" data-session={props.session} /> }));
vi.mock('./CellPanel.jsx', () => ({
  default: (props) => (
    <div data-testid="peek-panel" data-cell={props.cellId} data-panel-port={props.panelPort} data-route={JSON.stringify(props.route)} />
  ),
}));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });
const off = (cell, tmuxSession) => ({ cell, tmuxSession, active: false, tmux: false, engine: 'agy.native' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-Dev', activity: 10, working: true }],
    cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
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
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [{ name: 'cloud-Dev', activity: 10, working: true }] }) });
  mocks.getRouteSessions.mockImplementation(async (_token, route) => {
    if (route.join('/') === 'hub') return { sessions: [{ name: 'cloud-Remote', activity: 5 }] };
    return { sessions: [] };
  });
  mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
    if (!route.length) return { available: true, cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')] };
    if (route.join('/') === 'hub') return { available: true, cells: [active('Remote', 'cloud-Remote')] };
    if (route.join('/') === 'stale') return { available: true, cells: [off('Stale Cell', 'cloud-Stale')] };
    return {
      available: true,
      cells: [{ cell: 'Degraded', tmuxSession: 'cloud-Degraded', active: true, tmux: false, degraded: true, engine: 'shell.local' }],
    };
  });
});

describe('CellSwitcher', () => {
  it('uses fresh local and route-qualified fleet data, keeps degraded visible and requires explicit opening', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={onPick} onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: 'Cells / cloud sessions' });
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(screen.getByRole('button', { name: /^Dev / }).getAttribute('aria-current')).toBe('true');
    const remote = screen.getByRole('button', { name: /^Remote / });
    expect(remote).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Degraded / }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: /^Research / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stale Cell / })).toBeNull();
    expect(screen.getByRole('button', { name: 'close cell switcher' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'select a cell' }).disabled).toBe(true);
    await waitFor(() => {
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']);
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['stale']);
      expect(mocks.getRouteSessions).toHaveBeenCalledWith('token', ['alerts']);
    });

    fireEvent.click(remote);
    expect(remote.getAttribute('aria-pressed')).toBe('true');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'open cell: Remote' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-Remote', node: 'hub', cellName: 'Remote' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes the full inventory deliberately and refuses an off target with an explicit status', async () => {
    const onPick = vi.fn();
    render(<CellSwitcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const research = screen.getByRole('button', { name: /^Research / });
    expect(research.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(research);
    expect(await screen.findByText('this cell is no longer active')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps deactivated cells out of active mode even when marked degraded', async () => {
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-Dev', activity: 10, working: true }],
      cells: [active('Dev', 'cloud-Dev')],
      nodeGroups: [
        {
          route: ['hub'], label: 'Hub', sessions: [],
          cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
        },
      ],
    });
    mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
      if (!route.length) return { available: true, cells: [active('Dev', 'cloud-Dev')] };
      return {
        available: true,
        cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
      };
    });
    mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    await waitFor(() => expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']));
    expect(screen.queryByRole('button', { name: /^Ghost Off / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^Ghost Off / }).getAttribute('aria-disabled')).toBe('true');
  });

  it('renders each distinct local cell exactly once (no client-side doubling)', async () => {
    const localCells = [
      active('Dev', 'cloud-Dev'), active('Alpha', 'cloud-Alpha'),
      off('Fork', 'cloud-Fork'), off('Gamma', 'cloud-Gamma'),
      active('Personal', 'cloud-Personal'), active('Research', 'cloud-Research'),
      off('Trading', 'cloud-Trading'), off('GameDev', 'cloud-GameDev'),
      off('GameAuditor', 'cloud-GameAuditor'), active('SysAdmin', 'cloud-SysAdmin'),
      off('DesignCreator', 'cloud-DesignCreator'), off('WarMaster', 'cloud-WarMaster'),
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
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    for (const cell of localCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
  });

  // Forma REALE misurata il 2026-08-06 su un client federato (Pixel): il nodo
  // VL vive su VPS3, quindi `vlNodeToPeer` gli assegna la route dell'OWNER —
  // la stessa route del gruppo Fleet di VPS3. Due gruppi, una sola posizione.
  // Il test precedente ('no client-side doubling') usa nodeGroups: [] e non
  // puo' vedere questo caso: il difetto vive esattamente nei gruppi.
  it('never doubles a fleet position when a VL node shares its route', async () => {
    const route = ['cloud-example-com'];
    const vpsCells = [
      active('Dev', 'cloud-Dev'), active('Personal', 'cloud-Personal'),
      active('Research', 'cloud-Research'), active('SysAdmin', 'cloud-SysAdmin'),
    ];
    const vpsSessions = vpsCells.map((c) => ({ name: c.tmuxSession, activity: 1 }));
    writeCellSwitcherSnapshot({
      // Il Pixel non ha celle proprie attive: tutto cio' che si vede arriva
      // dalla posizione remota.
      sessions: [],
      cells: [],
      nodeGroups: [
        { route, label: 'VPS_Cloud', sessions: vpsSessions, cells: vpsCells },
        // Come lo produce vlSidebarGroups: cells vuote, e concatenato DOPO i
        // gruppi Fleet (useNodes.js) — per questo, a chiave uguale, vince lui.
        { kind: 'vl', name: 'vl-82dffb30', route, label: 'N900', sessions: [], cells: [] },
      ],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
    mocks.getRouteSessions.mockResolvedValue({ sessions: vpsSessions });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: vpsCells }
      : { available: true, cells: [] }));

    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    for (const cell of vpsCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
    // Un nodo VL non e' una posizione Fleet: non deve prestare la sua etichetta
    // alle celle di VPS3. Se questa riga passa mentre quella sopra fallisce, la
    // duplicazione e' solo mascherata.
    expect(screen.queryByText(/N900/)).toBeNull();
  });

  it('shows cell telemetry with its direction baked into the text: context is free, tiers are used', async () => {
    const telemetry = { ts: Date.now(), contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8 };
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-Dev', activity: 10, working: true, telemetry }],
      cells: [active('Dev', 'cloud-Dev')],
      nodeGroups: [],
    });
    // Anche il poll deve riportarla, o la riga la mostra e la perde al primo refresh.
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 10, working: true, telemetry }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    // Il verso è scritto DENTRO ogni etichetta: «free» sul contesto E «used»
    // su ogni tier. Un tier senza il suo verso prenderebbe per contagio il
    // «free» del vicino e la riga direbbe il contrario del vero.
    expect(await screen.findByText('context 71% free · 5h used 33% · 7d used 8%')).toBeTruthy();
  });

  it('no telemetry, no field: cells that do not publish it keep the row exactly as it was', async () => {
    // Nessuna sessione porta telemetria (celle non-Claude: assenza legittima).
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await screen.findByRole('button', { name: /^Research / });
    expect(document.querySelectorAll('.nc-cell-switcher-telemetry').length).toBe(0);
    // E nemmeno un segnaposto al posto del campo: nessuna percentuale, mai.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('the popup shows the CURRENT content of the peeked cell, never a saved frame of it', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('Dev', 'cloud-Dev')] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0, preview: 'frame-uno' }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Peek without switching cell: Dev' }));
    // Il pre del popup è il contenuto della sorgente; la preview compare
    // anche nello subtitle della riga, quindi si mira al selettore preciso.
    await waitFor(() => expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('frame-uno'));
    // La lista si aggiorna sotto (poll): la STESSA cella ha una preview nuova.
    // Il popup tiene una chiave e ri-risolve la riga: deve mostrare il
    // presente di quella cella, non il fotogramma di quando è stata aperta.
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0, preview: 'frame-due-fresca' }],
    }) });
    await waitFor(() => expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('frame-due-fresca'), { timeout: 6000 });
  });

  it('a cell that disappears from the updated list closes the popup instead of showing its dead frame', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('Dev', 'cloud-Dev')] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0, preview: 'frame-ultimo' }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Peek without switching cell: Dev' }));
    await waitFor(() => expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('frame-ultimo'));
    // La cella muore sotto il popup: la chiave non risolve più niente e il
    // popup si chiude da sé. L'alternativa — l'anteprima di un'altra cella
    // creduta la propria — è il difetto che questo test tiene chiuso.
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dev' })).toBeNull(), { timeout: 6000 });
  });

  it('streaming is a source of the popup: opened from the row, of that cell, and it never selects it', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [active('Dev', 'cloud-Dev')] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0 }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'Stream: Dev' }));
    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('cloud-Dev');
    // Guardare non è selezionare: nessuna riga premuta, l'apertura resta chiusa.
    expect(screen.getByRole('button', { name: /^Dev / }).getAttribute('aria-pressed')).not.toBe('true');
    expect(screen.getByRole('button', { name: 'select a cell' }).disabled).toBe(true);
  });

  it('the AIDesktop panel is reachable from the list when the cell publishes a panelUrl', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [
      { ...active('Dev', 'cloud-Dev'), panelUrl: 'https://panel.example' },
    ] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0 }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'Panel: Dev' }));
    const panel = await screen.findByTestId('peek-panel');
    expect(panel.getAttribute('data-cell')).toBe('Dev');
  });

  // P0 sicurezza: con una porta nota il frame va su un origin SEPARATO dal
  // control plane — e' quella separazione a impedire al JS del pannello di
  // raggiungere il token dell'operatore. Passare 0 (o un valore sbagliato)
  // ricade su un path relativo, cioe' SAME-ORIGIN col control plane: il
  // difetto chiuso in 0.9.1, riaperto in questo ingresso.
  it('panel origin: a LOCAL cell panel uses the node\'s own panel port, never 0 when one is configured', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [
      { ...active('Dev', 'cloud-Dev'), panelUrl: 'https://panel.example' },
    ] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [{ name: 'cloud-Dev', activity: 0 }],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()}
      panelPort={41821} nodePanelPorts={{}} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'Panel: Dev' }));
    const panel = await screen.findByTestId('peek-panel');
    expect(panel.dataset.panelPort).toBe('41821');
  });

  it('panel origin: a REMOTE cell with a negotiated port for its route gets that port, never the local one', async () => {
    writeCellSwitcherSnapshot({
      sessions: [], cells: [],
      nodeGroups: [{
        route: ['hub'], label: 'Hub', sessions: [{ name: 'cloud-Remote', activity: 0 }],
        cells: [{ ...active('Remote', 'cloud-Remote'), panelUrl: 'https://panel.example' }],
      }],
    });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: [{ ...active('Remote', 'cloud-Remote'), panelUrl: 'https://panel.example' }] }
      : { available: true, cells: [] }));
    mocks.getRouteSessions.mockResolvedValue({ sessions: [{ name: 'cloud-Remote', activity: 0 }] });
    // Porta LOCALE deliberatamente diversa dalla porta negoziata per 'hub':
    // se il frame prendesse quella locale sarebbe l'origine SBAGLIATA per
    // una cella remota, non un fallback innocuo.
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      panelPort={9999} nodePanelPorts={{ hub: 41821 }} />);
    await screen.findByRole('button', { name: /^Remote / });
    fireEvent.click(screen.getByRole('button', { name: 'Panel: Remote' }));
    const panel = await screen.findByTestId('peek-panel');
    expect(panel.dataset.panelPort).toBe('41821');
    expect(panel.dataset.panelPort).not.toBe('9999');
  });

  it('panel origin — no regression: a REMOTE cell whose route has NO negotiated port stays at 0, never borrows the local one', async () => {
    writeCellSwitcherSnapshot({
      sessions: [], cells: [],
      nodeGroups: [{
        route: ['unpaired'], label: 'Unpaired', sessions: [{ name: 'cloud-Remote', activity: 0 }],
        cells: [{ ...active('Remote', 'cloud-Remote'), panelUrl: 'https://panel.example' }],
      }],
    });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: [{ ...active('Remote', 'cloud-Remote'), panelUrl: 'https://panel.example' }] }
      : { available: true, cells: [] }));
    mocks.getRouteSessions.mockResolvedValue({ sessions: [{ name: 'cloud-Remote', activity: 0 }] });
    // 'unpaired' non e' nella mappa negoziata (peer accoppiato prima che il
    // pairing negoziasse la porta pannello): questa e' esattamente la guardia
    // di lib/panel-port.js che non va regredita.
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()}
      panelPort={9999} nodePanelPorts={{ hub: 41821 }} />);
    await screen.findByRole('button', { name: /^Remote / });
    fireEvent.click(screen.getByRole('button', { name: 'Panel: Remote' }));
    const panel = await screen.findByTestId('peek-panel');
    expect(panel.dataset.panelPort).toBe('0');
  });

  it('the row renders what the cell is doing: fresh activity as its age, stale or absent as nothing', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [
      active('Dev', 'cloud-Dev'), active('Research', 'cloud-Research'),
    ] }));
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [
        { name: 'cloud-Dev', activity: Date.now() - 2 * 60 * 1000 },
        { name: 'cloud-Research', activity: Date.now() - 2 * 60 * 60 * 1000 },
      ],
    }) });
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    // Fresca: l'età c'è, con la sua etichetta. Stantia (2h): oltre soglia il
    // campo sparisce — un valore morto che sembra fresco è peggio di nessuno.
    await waitFor(() => expect(screen.getByText(/activity \d+m/)).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByText(/activity \d+h/)).toBeNull();
    expect(document.querySelectorAll('.nc-cell-switcher-telemetry').length).toBe(1);
  });

  it('closes on Escape without trapping focus', () => {
    const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves unmanaged sessions in the shared order and keeps an off cell in place when it returns', async () => {
    const localSessions = [
      { name: 'cloud-Dev', activity: 10, working: true },
      { name: 'my-build-watch', activity: 5, preview: 'watching build' },
    ];
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({
      local: ['cloud-Dev', 'my-build-watch', 'cloud-Research'],
    }));
    writeCellSwitcherSnapshot({
      sessions: localSessions,
      cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: localSessions }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
    });
    const first = render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const researchHandle = screen.getByRole('button', { name: 'reorder Research' });
    const devRow = screen.getByRole('button', { name: /^Dev / }).closest('[data-roster-key]');
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => devRow) });
    fireEvent.pointerDown(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 20 });
    fireEvent.pointerMove(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    fireEvent.pointerUp(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))?.local)
      .toEqual(['cloud-Research', 'cloud-Dev', 'my-build-watch']));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
    expect(researchHandle.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');

    first.unmount();
    writeCellSwitcherSnapshot({
      sessions: [
        { name: 'cloud-Dev', activity: 10, working: true },
        { name: 'cloud-Research', activity: 2, working: false },
      ],
      cells: [active('Dev', 'cloud-Dev'), active('Research', 'cloud-Research')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [
        { name: 'cloud-Dev', activity: 10, working: true },
        { name: 'cloud-Research', activity: 2, working: false },
      ],
    }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('Dev', 'cloud-Dev'), active('Research', 'cloud-Research')],
    });
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Research / });
    expect([...document.querySelectorAll('.nc-cell-switcher-row[data-position="local"]')]
      .map((row) => row.dataset.rosterKey)).toEqual(['cloud-Research', 'cloud-Dev']);
  });
});
