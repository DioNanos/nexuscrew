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
    expect(screen.getByRole('button', { name: /^cell-One / }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('you are here')).toBeTruthy();
    const remote = screen.getByRole('button', { name: /^Remote / });
    expect(remote).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Degraded / }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: /^cell-Three / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stale Cell / })).toBeNull();
    expect(screen.getByRole('button', { name: 'close cell switcher' })).toBeTruthy();
    await waitFor(() => {
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']);
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['stale']);
      expect(mocks.getRouteSessions).toHaveBeenCalledWith('token', ['alerts']);
    });

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
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^cell-One / });
    await waitFor(() => expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']));
    expect(screen.queryByRole('button', { name: /^Ghost Off / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^Ghost Off / }).getAttribute('aria-disabled')).toBe('true');
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
    fireEvent.click(remote); // secondo tocco: apre con la verifica
    expect(await screen.findByText('Could not verify: try again shortly.')).toBeTruthy();
    expect(screen.queryByText('this cell is no longer active')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
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

  it('clicking a row whose status could not be read says not confirmed, not no longer active', async () => {
    // Primo refresh con lettura flotta fallita: le righe restano (ultimo
    // snapshot noto) come «status not confirmed» — cliccarle non può dire
    // «non più attiva», perché nessuno ha potuto leggerle.
    mocks.fleetStatus.mockImplementation(async () => { throw new Error('HTTP 502'); });
    render(<Switcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'all' });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const dev = await screen.findByRole('button', { name: /^cell-One / });
    expect(dev.textContent).toContain('status not confirmed');
    fireEvent.click(dev);
    // Il notice ha role="status" proprio: le righe portano lo stesso testo
    // come <small>, findByText sarebbe ambiguo.
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toBe('status not confirmed');
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
