import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// La nuvola al passaggio e il menu azioni (⋯) nella
// sidebar. I gesti che c'erano restano: clic riga = riquadro, doppio clic =
// vista singola, trascina, clic sul pallino della mini-rail — le non-regressioni
// vivono in Sidebar.test.jsx; qui si verifica il nuovo senza rompere il vecchio.
// Stesso pattern di mock di Sidebar.test.jsx: Terminal/CellPanel pesanti fuori.
vi.mock('./Terminal.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPeek.jsx', () => ({
  default: ({ row, onClose }) => (
    <div role="dialog" aria-label={row.cellName} data-testid="cell-peek">
      <span className="nc-peek-testo">{row.preview}</span>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ),
  CellPeekBody: ({ row, source, onSourceChange }) => (
    <div data-testid="peek-body" data-source={source}>
      <button type="button" role="tab" aria-selected="true"
        onClick={() => onSourceChange && onSourceChange('preview')}>{source}</button>
      <span className="nc-peek-testo">{row.preview}</span>
    </div>
  ),
}));
vi.mock('../lib/live-host-command.js', () => ({
  runLiveHostCommand: vi.fn(async () => ({ ok: true, messageKey: 'live-host-designated', hostCell: 'Local Cell' })),
}));

import Sidebar from './Sidebar.jsx';
import { runLiveHostCommand } from '../lib/live-host-command.js';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const aliveProps = (extra = {}) => ({
  cells: [{ cell: 'Local Cell', tmuxSession: 'local-cell', tmux: true, active: true }],
  sessions: [{ name: 'local-cell', preview: 'anteprima viva', activity: 42, outbox: { count: 2, latest: 1700000000000 } }],
  nodeGroups: [],
  onPick: vi.fn(),
  onAddTile: vi.fn(),
  onSettings: vi.fn(),
  ...extra,
});

const dotEspanso = () => {
  const row = screen.getByText('Local Cell').closest('.nc-cell');
  return row.querySelector('.nc-side-peek');
};
// Il dot va catturato PRIMA di aprire la nuvola: dentro la nuvola il nome e
// la preview della cella compaiono un'altra volta, e i getByText screen-wide
// diventano ambigui.
const apriNuvola = async () => {
  const dot = dotEspanso();
  fireEvent.mouseEnter(dot);
  await act(async () => { vi.advanceTimersByTime(310); });
  return { cloud: screen.getByTestId('peek-cloud'), dot };
};

describe('Nuvola al passaggio sul pallino', () => {
  it('sale dopo ~300 ms sul pallino, già in sorgente Live, col nome della cella', async () => {
    render(<Sidebar {...aliveProps()} />);
    const dot = dotEspanso();
    fireEvent.mouseEnter(dot);
    // Non è istantanea: il passaggio non deve aprire nulla chi non vuole.
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByTestId('peek-cloud')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(210); });
    const cloud = screen.getByTestId('peek-cloud');
    expect(within(cloud).getByText('Local Cell')).toBeTruthy();
    expect(cloud.querySelector('.nc-peek-testo').textContent).toBe('anteprima viva');
    expect(cloud.querySelector('[data-testid="peek-body"]').getAttribute('data-source')).toBe('stream');
  });

  it('uscendo dal pallino chiude dopo il tempo di grazia; entrando nella nuvola si resta', async () => {
    render(<Sidebar {...aliveProps()} />);
    const { dot } = await apriNuvola();
    fireEvent.mouseLeave(dot);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByTestId('peek-cloud')).toBeTruthy(); // nel tempo di grazia
    fireEvent.mouseEnter(screen.getByTestId('peek-cloud')); // raggiunta in tempo
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId('peek-cloud')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId('peek-cloud'));
    act(() => { vi.advanceTimersByTime(160); });
    expect(screen.queryByTestId('peek-cloud')).toBeNull(); // uscendo da entrambi, chiusa
  });

  it('la puntina diventa la finestra libera (CellPopup) e chiude la nuvola', async () => {
    const onPeekOpen = vi.fn();
    render(<Sidebar {...aliveProps({ onPeekOpen })} />);
    await apriNuvola();
    fireEvent.click(screen.getByRole('button', { name: 'Open window: Local Cell' }));
    expect(screen.queryByTestId('peek-cloud')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
    expect(onPeekOpen).toHaveBeenCalledTimes(1);
  });

  it('il CLICK sul pallino resta il peek completo (gesto invariato) e chiude la nuvola', async () => {
    const onAddTile = vi.fn();
    render(<Sidebar {...aliveProps({ onAddTile })} />);
    const dot = dotEspanso();
    fireEvent.mouseEnter(dot);
    await act(async () => { vi.advanceTimersByTime(310); });
    fireEvent.click(dot);
    expect(screen.getByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
    expect(screen.queryByTestId('peek-cloud')).toBeNull();
    expect(onAddTile).not.toHaveBeenCalled();
  });

  it('con il popup aperto la nuvola non sale (una sbirciata alla volta)', async () => {
    render(<Sidebar {...aliveProps()} />);
    fireEvent.click(dotEspanso());
    expect(screen.getByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
    fireEvent.mouseEnter(dotEspanso());
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByTestId('peek-cloud')).toBeNull();
  });

  it('mini-rail: il pallino di una cella viva apre la nuvola; il clic resta la tile', async () => {
    const onAddTile = vi.fn();
    const { container } = render(<Sidebar {...aliveProps({ collapsed: true, onAddTile })} />);
    const dot = container.querySelector('.nc-mini-dot');
    fireEvent.mouseEnter(dot);
    await act(async () => { vi.advanceTimersByTime(310); });
    expect(screen.getByTestId('peek-cloud')).toBeTruthy();
    fireEvent.click(dot);
    expect(onAddTile).toHaveBeenCalledWith('local-cell'); // gesto conservato
    expect(screen.queryByTestId('peek-cloud')).toBeNull();
  });
});

describe('Menu azioni (⋯) nella riga sidebar', () => {
  it('apre il popover, il boot è interruttore e chiude dopo il gesto', async () => {
    const onBoot = vi.fn(async () => {});
    render(<Sidebar {...aliveProps({ fleetCapabilities: ['boot'], onBoot })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cell actions: Local Cell' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Assign Live' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Pin to top' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Watch live' })).toBeTruthy();
    const boot = within(menu).getByRole('menuitemcheckbox', { name: 'Boot at startup' });
    expect(boot.getAttribute('aria-checked')).toBe('false');
    // Fake timers: niente waitFor (usa timer reali) — il mock risolve subito.
    await act(async () => { fireEvent.click(boot); });
    expect(onBoot).toHaveBeenCalledWith('Local Cell', true, []);
    expect(screen.queryByRole('menu')).toBeNull(); // chiuso dopo il gesto
  });

  it('NEGATIVO: senza capability boot la voce boot non esiste, non è disabilitata', () => {
    render(<Sidebar {...aliveProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cell actions: Local Cell' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Boot at startup' })).toBeNull();
  });

  it('NEGATIVO: cella spenta — niente «Watch live» nel menu', () => {
    render(<Sidebar {...aliveProps({
      cells: [{ cell: 'Local Cell', tmuxSession: 'local-cell', tmux: false, active: false }],
    })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cell actions: Local Cell' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Watch live' })).toBeNull();
  });

  it('la voce Live dice Togli quando la cella È host, e l\'esito finisce in striscia', async () => {
    render(<Sidebar {...aliveProps({
      hostByRoute: { local: { hostCell: 'Local Cell', threadStatus: 'absent' } },
    })} />);
    // Il bollino sulla riga dice la stessa cosa (la riga è la prima .nc-cell:
    // il nome host compare anche nella striscia in testa).
    const row = document.querySelector('.nc-cell');
    expect(within(row).getByText('LIVE')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Cell actions: Local Cell' }));
    await act(async () => { fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove Live' })); });
    expect(runLiveHostCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'remove', cellId: 'Local Cell', route: [],
    }));
    // Striscia Live: l'esito visibile, con la cella al posto del segnaposto.
    expect(screen.getByText('Live host: Local Cell')).toBeTruthy();
  });

  it('«Watch live» apre il peek in sorgente Flusso (stream)', () => {
    render(<Sidebar {...aliveProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cell actions: Local Cell' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Watch live' }));
    expect(screen.getByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
  });

  it('rel attività e badge outbox vivono sulla riga', () => {
    render(<Sidebar {...aliveProps()} />);
    const row = screen.getByText('Local Cell').closest('.nc-cell');
    expect(row.querySelector('.nc-rel')).toBeTruthy();
    expect(row.querySelector('.nc-badge').textContent).toBe('2');
  });
});
