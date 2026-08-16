import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// I figli pesanti (Terminal/Composer/Files) fanno chiamate di rete: stub.
// grid-model e terminal-lifecycle restano reali (puri, senza rete).
vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
// CellPanel fa la sua propria chiamata di rete (requestPanelTicket): qui
// interessa solo il CONTENITORE (GridTile), gia' coperto a fondo da
// CellPanel.test.jsx. Lo stub espone le props ricevute per verificare che
// GridTile passi cellId/panelUrl/panelPort giusti, senza rifare quei test.
vi.mock('./CellPanel.jsx', () => ({
  default: ({ cellId, panelUrl, panelPort }) => (
    <div data-testid="panel" data-cell-id={cellId} data-panel-url={panelUrl} data-panel-port={panelPort} />
  ),
}));
// CellPopup e' il contenitore condiviso (lista/live/vista singola/griglia),
// gia' coperto a fondo da CellPopup.test.jsx (Esc, clic fuori, fuoco). Qui
// interessa solo che GridTile lo monti col figlio giusto e reagisca a onClose.
vi.mock('./CellPopup.jsx', () => ({
  default: ({ title, onClose, children }) => (
    <div data-testid="popup" data-title={title}>
      <button type="button" onClick={onClose}>chiudi-popup</button>
      {children}
    </div>
  ),
}));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import GridTile from './GridTile.jsx';

function renderTile(props) {
  return render(
    <GridTile
      session="cloud-Dev"
      token="t"
      onFocus={vi.fn()}
      {...props}
    />,
  );
}

describe('GridTile title (Tranche D)', () => {
  it('shows the logical Fleet cell name, not the tmux session name', () => {
    renderTile({ session: 'cloud-Dev', cellName: 'Dev' });
    const title = screen.getByText('Dev');
    expect(title.tagName).toBe('B');
    // la tmuxSession non deve comparire nel titolo visibile
    expect(screen.queryByText('cloud-Dev')).toBeNull();
  });

  it('does not show the @node chip for a remote cell', () => {
    // cell=Dev, tmuxSession=cloud-Dev, route workstation -> solo "Dev" visibile.
    renderTile({ session: 'cloud-Dev', node: 'workstation', cellName: 'Dev' });
    expect(screen.queryByText('workstation')).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.getByText('Dev')).toBeTruthy();
  });

  it('keeps a sanitized technical identifier only in the tooltip, not in visible text', () => {
    renderTile({ session: 'cloud-Dev', node: 'workstation', cellName: 'Dev' });
    const btn = screen.getByText('Dev').closest('button');
    expect(btn.getAttribute('title')).toContain('workstation');
    // il testo visibile del bottone resta il solo nome logico
    expect(btn.textContent.trim()).toBe('Dev');
  });

  it('uses a plain tooltip equal to the visible name for a local tile', () => {
    renderTile({ session: 'cloud-Dev', cellName: 'Dev' });
    const btn = screen.getByText('Dev').closest('button');
    expect(btn.getAttribute('title')).toBe('Dev');
  });

  it('falls back to the session name for an unmanaged session', () => {
    renderTile({ session: 'scratch-pad', cellName: 'scratch-pad' });
    expect(screen.getByText('scratch-pad')).toBeTruthy();
    expect(screen.queryByText('cloud-Dev')).toBeNull();
  });

  it('defaults the visible title to the session when cellName is not provided (back-compat)', () => {
    renderTile({ session: 'my-session', cellName: undefined });
    expect(screen.getByText('my-session')).toBeTruthy();
  });

  it('renders two tiles with the same cell name on different nodes without @node collisions', () => {
    const { container } = render(
      <>
        <GridTile session="cloud-Dev" node="workstation" cellName="Dev" token="t" onFocus={vi.fn()} />
        <GridTile session="cloud-Dev" node="vps/relay" cellName="Dev" token="t" onFocus={vi.fn()} />
      </>,
    );
    const titles = container.querySelectorAll('b');
    expect(titles).toHaveLength(2);
    titles.forEach((b) => expect(b.textContent).toBe('Dev'));
    // nessun chip @node visibile
    expect(container.textContent).not.toContain('@');
  });
});

// --- D8-griglia: il pannello per-cella apribile dalla tile, non solo dalla
// vista singola. Prima di questo, aprire il browser di una cella obbligava a
// uscire dalla griglia e perdere le altre celle di vista. Il contenitore è
// CellPopup (condiviso con lista/live/vista singola): la tile porta solo il
// dato e il bottone, non reinventa un overlay proprio.
describe('GridTile panel (D8-griglia)', () => {
  it('il bottone pannello compare SOLO se la cella ha un panelUrl', () => {
    const { rerender } = render(
      <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()} />,
    );
    expect(screen.queryByTitle('panel')).toBeNull();
    rerender(
      <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()}
        panelUrl="https://127.0.0.1:6901/vnc.html" panelCellId="Dev" />,
    );
    expect(screen.getByTitle('panel')).toBeTruthy();
  });

  it('aprendo il pannello, il terminale della tile resta montato (stesso nodo DOM)', () => {
    render(
      <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()}
        panelUrl="https://127.0.0.1:6901/vnc.html" panelCellId="Dev" />,
    );
    const termBefore = screen.getByTestId('term');
    expect(screen.queryByTestId('popup')).toBeNull(); // chiuso di default
    fireEvent.click(screen.getByTitle('panel'));
    expect(screen.getByTestId('popup')).toBeTruthy();
    expect(screen.getByTestId('panel')).toBeTruthy();
    // stesso elemento DOM: nessun remount del terminale al toggle del pannello.
    expect(screen.getByTestId('term')).toBe(termBefore);
  });

  it('il popup passa il titolo visibile della cella e si richiude via onClose', () => {
    render(
      <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()}
        panelUrl="https://127.0.0.1:6901/vnc.html" panelCellId="Dev" />,
    );
    fireEvent.click(screen.getByTitle('panel'));
    expect(screen.getByTestId('popup').dataset.title).toBe('Dev');
    fireEvent.click(screen.getByText('chiudi-popup'));
    expect(screen.queryByTestId('popup')).toBeNull();
    // il terminale non se n'e' mai andato: chiudere il popup non tocca la tile.
    expect(screen.getByTestId('term')).toBeTruthy();
  });

  it('il pannello riceve cellId/panelUrl/panelPort dalla tile, non una fonte propria', () => {
    render(
      <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()}
        panelUrl="https://127.0.0.1:6901/vnc.html" panelCellId="Dev" panelPort={41821} />,
    );
    fireEvent.click(screen.getByTitle('panel'));
    const panel = screen.getByTestId('panel');
    expect(panel.dataset.cellId).toBe('Dev');
    expect(panel.dataset.panelUrl).toBe('https://127.0.0.1:6901/vnc.html');
    expect(panel.dataset.panelPort).toBe('41821');
  });

  it('due tile con pannello aperto non interferiscono fra loro', () => {
    const { container } = render(
      <>
        <GridTile session="cloud-Dev" cellName="Dev" token="t" onFocus={vi.fn()}
          panelUrl="https://127.0.0.1:6901/vnc.html" panelCellId="Dev" />
        <GridTile session="cloud-Fork" cellName="Fork" token="t" onFocus={vi.fn()}
          panelUrl="https://127.0.0.1:6902/vnc.html" panelCellId="Fork" />
      </>,
    );
    const buttons = screen.getAllByTitle('panel');
    expect(buttons).toHaveLength(2);
    // apre SOLO il pannello della prima tile.
    fireEvent.click(buttons[0]);
    const panels = container.querySelectorAll('[data-testid="panel"]');
    expect(panels).toHaveLength(1);
    expect(panels[0].dataset.cellId).toBe('Dev');
    // entrambi i terminali restano montati indipendentemente dal toggle.
    expect(screen.getAllByTestId('term')).toHaveLength(2);
    // apre anche la seconda: le due restano distinte, nessuna sovrascrive l'altra.
    fireEvent.click(buttons[1]);
    const panelsAfter = container.querySelectorAll('[data-testid="panel"]');
    expect(panelsAfter).toHaveLength(2);
    const ids = Array.from(panelsAfter).map((p) => p.dataset.cellId).sort();
    expect(ids).toEqual(['Dev', 'Fork']);
  });
});
