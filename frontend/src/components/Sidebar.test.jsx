import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Sidebar ora importa CellPeek (popup) che a sua volta importa Terminal
// (@xterm/xterm) e CellPanel: pesanti e non relevant per i test della lista.
// Stesso pattern di GridTile.test.jsx e CellSwitcher.test.jsx.
vi.mock('./Terminal.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPeek.jsx', () => ({
  default: ({ row, onClose }) => (
    <div role="dialog" aria-label={row.cellName} data-testid="cell-peek">
      <span className="nc-peek-testo">{row.preview}</span>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ),
}));

import Sidebar from './Sidebar.jsx';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

describe('Sidebar session identity', () => {
  // Il bersaglio della correzione: sul DESKTOP la lista che si usa davvero è
  // questa. Il pallino verde deve essere un bersaglio SUO che apre il popup —
  // DUE asserzioni: il popup si apre E la cella NON entra in griglia. Il resto
  // della riga continua a fare la tile: il gesto che c'era resta.
  const peekProps = (onAddTile) => ({
    cells: [{ cell: 'Local Cell', tmuxSession: 'local-cell', tmux: true, active: true }],
    sessions: [{ name: 'local-cell', preview: 'anteprima locale' }],
    nodeGroups: [],
    onPick: vi.fn(),
    onAddTile,
    onSettings: vi.fn(),
  });

  it('desktop: cliccare il PALLINO apre il popup E non aggiunge la tile (due asserzioni)', async () => {
    const onAddTile = vi.fn();
    const { container } = render(<Sidebar {...peekProps(onAddTile)} />);
    const row = screen.getByText('Local Cell').closest('.nc-cell');
    const dot = row.querySelector('.nc-dot');
    fireEvent.click(dot);
    expect(await screen.findByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
    expect(onAddTile).not.toHaveBeenCalled();
    // e dentro c'è l'anteprima della cella giusta (nel <pre> del popup)
    expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('anteprima locale');
  });

  it('desktop: cliccare il RESTO della riga aggiunge la tile come prima (non-regressione)', () => {
    const onAddTile = vi.fn();
    render(<Sidebar {...peekProps(onAddTile)} />);
    fireEvent.click(screen.getByText('Local Cell'));
    expect(onAddTile).toHaveBeenCalledWith('local-cell');
    expect(screen.queryByRole('dialog', { name: 'Local Cell' })).toBeNull();
  });

  // IL DIFETTO CERCATO: il popup della sidebar e quello dello switcher sono
  // due overlay fissi. Se si aprono entrambi, si sovrappongono — due dialog
  // aria-modal che si contendono il fuoco. La policy voluta: UNO solo. Aprire
  // dalla sidebar chiude lo switcher (onPeekOpen); aprire lo switcher chiude
  // il peek della sidebar. L'asserzione: quando la sidebar apre il popup,
  // onPeekOpen viene chiamato (App lo collega a setCellSwitcherOpen(false)).
  it('desktop: aprire il popup della sidebar chiude lo switcher (un solo popup)', async () => {
    const onPeekOpen = vi.fn();
    const { container } = render(<Sidebar {...peekProps(vi.fn())} onPeekOpen={onPeekOpen} />);
    const row = screen.getByText('Local Cell').closest('.nc-cell');
    fireEvent.click(row.querySelector('.nc-dot'));
    expect(await screen.findByRole('dialog', { name: 'Local Cell' })).toBeTruthy();
    expect(onPeekOpen).toHaveBeenCalledTimes(1);
  });

  // IL DIFETTO CHE R4 AVEVA CHIUSO SU UN ALTRO ASSE. Il nome di una sessione
  // tmux non e' unico nella federazione: `host-Alpha` esiste su ogni nodo che
  // abbia quella cella. La sidebar indicizza le sessioni LOCALI per nome, e se
  // risolve li' anche la riga di una cella REMOTA il popup mostra l'anteprima
  // della cella locale omonima — di nuovo "un'altra cella creduta la propria",
  // stavolta per collisione di nome invece che per riga salvata.
  it('il popup di una cella REMOTA non prende l\'anteprima della sessione locale omonima', async () => {
    render(<Sidebar
      cells={[]}
      sessions={[{ name: 'host-Alpha', preview: 'ANTEPRIMA DELLA CELLA LOCALE', activity: 999 }]}
      nodeGroups={[{
        name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
        sessions: [], unmanaged: [], capabilities: [], engines: [],
        cells: [{ cell: 'Dev', tmuxSession: 'host-Alpha', tmux: true, active: true,
                  preview: 'anteprima della cella remota' }],
      }]}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()} />);
    const riga = screen.getByText('Dev').closest('.nc-cell');
    fireEvent.click(riga.querySelector('.nc-side-peek'));
    expect(await screen.findByRole('dialog', { name: 'Dev' })).toBeTruthy();
    const mostrato = document.querySelector('.nc-peek-testo')?.textContent;
    expect(mostrato).toBe('anteprima della cella remota');
    expect(mostrato).not.toBe('ANTEPRIMA DELLA CELLA LOCALE');
  });

  // Il verso positivo dello stesso criterio: risolvere nel nodo GIUSTO non
  // significa rinunciare al dato. Se il gruppo remoto porta le sue sessioni,
  // il popup legge di la' — come fa gia' SessionList — e la sessione vince sul
  // campo che viaggia con la cella, esattamente come nel caso locale.
  it('il popup di una cella REMOTA legge la sessione del SUO nodo, non solo il campo della cella', async () => {
    render(<Sidebar
      cells={[]}
      sessions={[{ name: 'host-Alpha', preview: 'ANTEPRIMA DELLA CELLA LOCALE' }]}
      nodeGroups={[{
        name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
        sessions: [{ name: 'host-Alpha', preview: 'anteprima dal nodo remoto', activity: 42 }],
        unmanaged: [], capabilities: [], engines: [],
        cells: [{ cell: 'Dev', tmuxSession: 'host-Alpha', tmux: true, active: true,
                  preview: 'campo che viaggia con la cella' }],
      }]}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()} />);
    const riga = screen.getByText('Dev').closest('.nc-cell');
    fireEvent.click(riga.querySelector('.nc-side-peek'));
    expect(await screen.findByRole('dialog', { name: 'Dev' })).toBeTruthy();
    expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('anteprima dal nodo remoto');
  });

  it('toggles boot from local and routed desktop rows without using power', async () => {
    const onBoot = vi.fn(async () => {}); const onPower = vi.fn();
    const onBootSettlementApplied = vi.fn();
    const props = {
      cells: [{ cell: 'Local Cell', tmuxSession: 'local-cell', tmux: true, active: true, boot: false }],
      sessions: [{ name: 'local-cell' }],
      nodeGroups: [{
        name: 'relay', label: 'Relay', route: ['relay'], status: 'up', instanceId: 'd'.repeat(32),
        sessions: [{ name: 'remote-cell' }], unmanaged: [], capabilities: ['up', 'down', 'boot'], engines: [],
        cells: [{ cell: 'Remote Cell', tmuxSession: 'remote-cell', tmux: true, active: true, boot: true, key: 'relay:remote-cell' }],
      }],
      fleetCapabilities: ['up', 'down', 'boot'],
      onBoot,
      onBootSettlementApplied,
      onPower,
      onPick: vi.fn(),
      onAddTile: vi.fn(),
      onSettings: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'enable at boot Local Cell' }));
    await waitFor(() => expect(onBoot).toHaveBeenCalledWith('Local Cell', true, []));
    expect(screen.getByRole('button', { name: 'disable at boot Local Cell' }).classList.contains('on')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[0]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({ cell: 'Local Cell', boot: true }));

    // PowerSheet conferma il valore opposto prima del poll: l'evento del
    // genitore deve sostituire subito l'override del toggle diretto.
    rerender(<Sidebar {...props} bootSettlement={{ id: 1, cell: 'Local Cell', route: [], enabled: false }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'enable at boot Local Cell' })).toBeTruthy());
    expect(onBootSettlementApplied).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[0]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({ cell: 'Local Cell', boot: false }));

    fireEvent.click(screen.getByRole('button', { name: 'disable at boot Remote Cell' }));
    await waitFor(() => expect(onBoot).toHaveBeenCalledWith('Remote Cell', false, ['relay']));
    expect(screen.getByRole('button', { name: 'enable at boot Remote Cell' }).classList.contains('on')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[1]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({
      cell: 'Remote Cell', boot: false, route: ['relay'],
    }));
  });

  it('opens local and remote rows with ownerId + tmux session coordinates', () => {
    const onPick = vi.fn();
    render(
      <Sidebar
        localNodeId={'c'.repeat(32)}
        sessions={[{ name: 'local-shell', activity: 2, windows: 1 }]}
        nodeGroups={[{
          name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
          sessions: [{ name: 'remote-shell', activity: 1, key: 'relay:remote-shell' }],
          unmanaged: [{ name: 'remote-shell', activity: 1, node: 'relay', key: 'relay:remote-shell' }],
          cells: [], capabilities: [], engines: [],
        }]}
        onPick={onPick} onAddTile={vi.fn()} onSettings={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText('local-shell').closest('[data-roster-key]'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'local-shell', ownerId: 'c'.repeat(32),
    });

    fireEvent.doubleClick(screen.getByText('remote-shell').closest('[data-roster-key]'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'remote-shell', node: 'relay', ownerId: 'd'.repeat(32),
    });
  });

  it('renders working, idle and off cell state from the shared runtime contract', () => {
    const baseProps = {
      localNodeId: 'c'.repeat(32),
      cells: [
        { cell: 'Working Cell', tmuxSession: 'cell-working', tmux: true, active: true, engine: 'codex.responses' },
        { cell: 'Off Cell', tmuxSession: 'cell-off', tmux: false, active: false, engine: 'claude.native', model: 'claude-opus-4-1' },
      ],
      onPick: vi.fn(), onAddTile: vi.fn(), onSettings: vi.fn(),
    };
    const { rerender } = render(
      <Sidebar {...baseProps} sessions={[{
        name: 'cell-working', activity: 2, windows: 1,
        working: true, status: 'Implement activity UI', preview: 'gpt-5.6-sol',
      }]} />,
    );

    const workingRow = screen.getByText('Working Cell').closest('[data-roster-key]');
    expect(within(workingRow).getByText(/Implement activity UI/)).toBeTruthy();
    expect(workingRow.querySelector('.nc-dot').classList.contains('working')).toBe(true);
    const offRow = screen.getByText('Off Cell').closest('[data-roster-key]');
    expect(within(offRow).getByText('claude.native · claude-opus-4-1')).toBeTruthy();
    expect(offRow.querySelector('.nc-dot').classList.contains('on')).toBe(false);

    rerender(<Sidebar {...baseProps} sessions={[{
      name: 'cell-working', activity: 3, windows: 1,
      working: false, status: '', paneTitle: 'Dev', preview: 'gpt-5.6-sol',
    }]} />);
    const idleRow = screen.getByText('Working Cell').closest('[data-roster-key]');
    expect(within(idleRow).getByText('idle')).toBeTruthy();
    expect(idleRow.querySelector('.nc-dot').classList.contains('working')).toBe(false);
    expect(idleRow.querySelector('.nc-dot').classList.contains('on')).toBe(true);
  });

  it('keeps the working signal in collapsed desktop and routed remote cells', () => {
    const common = { onPick: vi.fn(), onAddTile: vi.fn(), onSettings: vi.fn() };
    const { container, rerender } = render(<Sidebar {...common} collapsed
      cells={[{ cell: 'Local Worker', tmuxSession: 'local-worker', tmux: true, active: true, engine: 'codex.native' }]}
      sessions={[{ name: 'local-worker', working: true, status: 'Build release' }]} />);
    expect(container.querySelector('.nc-mini-dot .nc-dot').classList.contains('working')).toBe(true);

    rerender(<Sidebar {...common} cells={[]} sessions={[]} nodeGroups={[{
      name: 'relay', label: 'Relay', route: ['relay'], status: 'up', instanceId: 'd'.repeat(32),
      sessions: [{ name: 'remote-worker', working: true, status: 'Review remote diff' }],
      cells: [{
        cell: 'Remote Worker', tmuxSession: 'remote-worker', tmux: true, active: true,
        engine: 'claude.native', key: 'relay:remote-worker',
      }],
      unmanaged: [], capabilities: [], engines: [],
    }]} />);
    const remoteRow = screen.getByText('Remote Worker').closest('[data-roster-key]');
    expect(within(remoteRow).getByText(/Review remote diff/)).toBeTruthy();
    expect(remoteRow.querySelector('.nc-dot').classList.contains('working')).toBe(true);
  });

  it('renames direct nodes through the server callback and keeps local node ordering', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Studio Mac');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onNodeRename = vi.fn(async () => true);
    const nodeGroups = [
      { name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up', direct: true, sessions: [], unmanaged: [], cells: [] },
      { name: 'pixel', label: 'Pixel', route: ['relay', 'pixel'], instanceId: 'e'.repeat(32), status: 'up', sessions: [], unmanaged: [], cells: [] },
    ];
    render(<Sidebar nodeGroups={nodeGroups} onPick={vi.fn()} onAddTile={vi.fn()}
      onNodeRename={onNodeRename} onSettings={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText('Relay').closest('.nc-node-title'));
    expect(prompt).toHaveBeenCalled();
    expect(onNodeRename).toHaveBeenCalledWith(nodeGroups[0], 'Studio Mac');
    expect(localStorage.getItem('nc_node_aliases_v1')).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'reorder Pixel' }), { key: 'ArrowUp' });
    expect(JSON.parse(localStorage.getItem('nc_node_order_v1'))[0]).toBe(`id:${'e'.repeat(32)}`);
    expect(alert).not.toHaveBeenCalled();
    prompt.mockRestore(); alert.mockRestore();
  });
});

// --- Live per nodo (0.9.1 seconda meta'): la stella deve comandare il nodo
// GIUSTO — spia sulla chiamata, non solo "la funzione non esplode". Prima del
// fix la sezione remota non aveva affatto la stellina live (solo togglePin);
// il difetto e' quindi doppio: nessuna azione E nessuna lettura per route.
describe('Sidebar — cella ospite Live per nodo', () => {
  const remoteCellGroup = (extra = {}) => ({
    name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
    sessions: [], unmanaged: [], capabilities: [], engines: [],
    cells: [{ cell: 'Remote Cell', tmuxSession: 'remote-cell', tmux: true, active: true }],
    ...extra,
  });

  it('la stella su una cella FAVORITE remota designa con la route DI QUEL NODO (spia sulla chiamata)', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['relay:remote-cell']));
    const onDesignateCell = vi.fn();
    render(<Sidebar
      nodeGroups={[remoteCellGroup()]}
      onDesignateCell={onDesignateCell}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    fireEvent.click(screen.getByTitle('pin to top'));
    expect(onDesignateCell).toHaveBeenCalledWith('Remote Cell', ['relay']);
    // controllo negativo: col difetto originale la designazione parte SENZA
    // route (o con route vuota) e colpisce il nodo locale, non quello guardato.
    expect(onDesignateCell).not.toHaveBeenCalledWith('Remote Cell');
    expect(onDesignateCell).not.toHaveBeenCalledWith('Remote Cell', []);
  });

  it('la stellina remota e\' "live" SOLO quando hostByRoute[quella route] lo dice', () => {
    render(<Sidebar
      nodeGroups={[remoteCellGroup()]}
      hostByRoute={{ local: { hostCell: null }, relay: { hostCell: 'Remote Cell', hostRevision: 3 } }}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    expect(screen.getByTitle('live host')).toBeTruthy();
  });

  it('NEGATIVA: un hostCell locale con lo stesso nome non accende la stella di un nodo diverso', () => {
    render(<Sidebar
      nodeGroups={[remoteCellGroup()]}
      hostByRoute={{ local: { hostCell: 'Remote Cell' } }} // solo locale, MAI 'relay'
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    expect(screen.queryByTitle('live host')).toBeNull();
  });

  it('con permesso: clear su una cella live remota passa la route del nodo, non locale', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['relay:remote-cell']));
    const onClearHostCell = vi.fn(async () => true);
    render(<Sidebar
      nodeGroups={[remoteCellGroup()]}
      hostByRoute={{ relay: { hostCell: 'Remote Cell', hostRevision: 5 } }}
      onClearHostCell={onClearHostCell}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    fireEvent.click(screen.getByTitle('live host'));
    expect(onClearHostCell).toHaveBeenCalledWith(['relay']);
  });
});

// --- nodi VL nella sidebar (VL_NODES_IN_SIDEBAR, 2026-08-06) ----------------
// I gruppi NON sono costruiti a mano: partono dalla forma VERA di
// GET /api/vl-nodes (broker.list + arricchimento routes) e passano dallo
// stesso modello della produzione (vlNodeToPeer -> vlSidebarGroups). La
// lezione del profile_mismatch: un test che si costruisce il mondo non prova
// che il codice regga in quello reale.
import { vlNodeToPeer, vlSidebarGroups } from '../lib/vl-nodes-model.js';

const VL_API_NODE = {
  nodeId: 'f'.repeat(32),
  label: 'N900',
  pairedAt: 1700000000000,
  online: true,
  lastSeen: 1700000100000,
  generation: 1,
  version: '0.1.0',
  capabilities: ['status', 'health', 'prompt'],
  health: { state: 'running', uptimeSec: 10, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
  session: { attached: true, profile: 'ollama' },
  inflight: null,
  lastAck: null,
  id: `${'a'.repeat(32)}:VL-${'f'.repeat(32)}`,
  instanceId: 'a'.repeat(32),
  cell: `VL-${'ffffffff'}`,
  canReceive: false,
  canManage: true,
};

describe('Sidebar — nodi VL', () => {
  it('an attached N900 is a node group with one honest session that opens the events view', () => {
    const peer = vlNodeToPeer(VL_API_NODE);
    const onOpenVlSession = vi.fn();
    render(<Sidebar
      nodeGroups={vlSidebarGroups([peer])}
      onOpenVlSession={onOpenVlSession}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    expect(screen.getByText('N900')).toBeTruthy();
    expect(screen.getByText(/1 sessions?/)).toBeTruthy();
    const row = screen.getByText('ollama').closest('.nc-vl-session-row');
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onOpenVlSession).toHaveBeenCalledWith(peer);
    // niente semantiche tmux sulla riga VL: non draggabile, niente kill.
    expect(row.getAttribute('draggable')).not.toBe('true');
    expect(within(row).queryByTitle('terminate')).toBeNull();
  });

  it('a node that declares no attach counts zero sessions — never "1 in attesa"', () => {
    const peer = vlNodeToPeer({ ...VL_API_NODE, session: null });
    render(<Sidebar
      nodeGroups={vlSidebarGroups([peer])}
      onOpenVlSession={vi.fn()}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    const header = screen.getByText('N900').closest('.nc-node-title');
    expect(within(header).getByText(/0 sessions?/)).toBeTruthy();
    expect(screen.queryByText('ollama')).toBeNull();
  });

  it('an offline VL node shows what other offline nodes show', () => {
    const peer = vlNodeToPeer({ ...VL_API_NODE, online: false });
    render(<Sidebar
      nodeGroups={vlSidebarGroups([peer])}
      onOpenVlSession={vi.fn()}
      onPick={vi.fn()} onAddTile={vi.fn()} onSettings={vi.fn()}
    />);
    expect(screen.getByText('N900')).toBeTruthy();
    // stessa etichetta degli altri nodi offline (nodeStateLabel), mai un
    // conteggio: una sessione che non si puo' vedere non si conta.
    expect(screen.queryByText(/1 sessions?/)).toBeNull();
    expect(screen.queryByText('ollama')).toBeNull();
    expect(screen.getByText(/offline/i)).toBeTruthy();
  });
});
