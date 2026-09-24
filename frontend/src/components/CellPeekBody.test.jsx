import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, getLiveHost: mocks.getLiveHost,
  designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
// Le sorgenti pesanti del corpo fanno rete (ws, ticket del pannello): stub
// con traccia delle props, stesso pattern di CellSwitcher.test.jsx.
vi.mock('./Terminal.jsx', () => ({ default: (props) => (
  <div data-testid="peek-term" data-session={props.session}
    data-fontsize={props.fontSize} data-readonly={String(!!props.readonly)} />
) }));
vi.mock('./CellPanel.jsx', () => ({
  default: (props) => (
    <div data-testid="peek-panel" data-cell={props.cellId} data-panel-port={props.panelPort} data-route={JSON.stringify(props.route)} />
  ),
}));

import { CellPeekBody } from './CellPeek.jsx';

const row = (over = {}) => ({
  key: 'cell-One', cellName: 'cell-One', session: 'cloud-cell-One', active: true, ...over,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.getLiveHost.mockReset().mockResolvedValue({ hostCell: null, revision: 1, eligible: true, threadStatus: 'absent' });
  mocks.designateHostCell.mockReset();
  mocks.clearHostCell.mockReset();
  mocks.apiFetch.mockReset().mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
});

describe('CellPeekBody — il corpo della sbirciata (tab + sorgenti)', () => {
  it('la preview testuale è il contenuto PRESENTE della riga, mai un fotogramma salvato', () => {
    const { rerender } = render(<CellPeekBody row={row({ preview: 'frame-uno' })} token="token"
      source="preview" onSourceChange={() => {}} />);
    expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('frame-uno');
    // La riga aggiorna la propria preview: il corpo mostra il presente di
    // quella cella, non il fotogramma di quando è stata aperta.
    rerender(<CellPeekBody row={row({ preview: 'frame-due-fresca' })} token="token"
      source="preview" onSourceChange={() => {}} />);
    expect(document.querySelector('.nc-peek-testo')?.textContent).toBe('frame-due-fresca');
  });

  it('le sorgenti sono tab dello stesso corpo: con panelUrl sono tre, senza sono due', () => {
    const { unmount } = render(<CellPeekBody row={row({ panelUrl: 'https://panel.example' })} token="token"
      source="preview" onSourceChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Stream' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Panel' })).toBeTruthy();
    unmount();
    render(<CellPeekBody row={row()} token="token" source="stream" onSourceChange={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Panel' })).toBeNull();
  });

  it('panel: raggiungibile quando la cella pubblica panelUrl, e la porta del guscio arriva al frame', () => {
    render(<CellPeekBody row={row({ panelUrl: 'https://panel.example' })} token="token"
      source="panel" onSourceChange={() => {}} panelPort={41821} />);
    const panel = screen.getByTestId('peek-panel');
    expect(panel.getAttribute('data-cell')).toBe('cell-One');
    // P0: con una porta nota il frame va su un origin SEPARATO dal control
    // plane. La risoluzione porta→route (locale, remota negoziata, zero) è
    // la guardia di lib/panel-port.js (panel-port.test.js); qui si verifica
    // il contratto del corpo: la porta risolta ARRIVA al frame.
    expect(panel.dataset.panelPort).toBe('41821');
  });

  it('chrome=false: il corpo è NUDO — niente tab, niente comando Live host, solo la sorgente', () => {
    render(<CellPeekBody row={row({ panelUrl: 'https://panel.example' })} token="token"
      source="stream" chrome={false} panelPort={41821} />);
    expect(screen.getByTestId('peek-term').getAttribute('data-session')).toBe('cloud-cell-One');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(document.querySelector('.nc-peek-sorgenti')).toBeNull();
    expect(document.querySelector('.nc-peek-host')).toBeNull();
  });
});
